import {
  css,
  CSSResultGroup,
  html,
  nothing,
  LitElement,
  PropertyValues,
  TemplateResult,
} from "lit";
import { mdiMicrophone, mdiMicrophoneOff } from "@mdi/js";
import { customElement, property, state, query } from "lit/decorators";
import { isComponentLoaded } from "../common/config/is_component_loaded";
import { fireEvent } from "../common/dom/fire_event";
import {
  handleWebRtcOffer,
  WebRtcAnswer,
  fetchWebRtcConfig,
  closeWebRtcStream,
} from "../data/camera";
import { fetchWebRtcSettings } from "../data/rtsp_to_webrtc";
import type { HomeAssistant } from "../types";
import "./ha-alert";

/**
 * A WebRTC stream is established by first sending an offer through a signal
 * path via an integration. An answer is returned, then the rest of the stream
 * is handled entirely client side.
 */
@customElement("ha-web-rtc-player")
class HaWebRtcPlayer extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property() public entityid!: string;

  @property({ type: Boolean, attribute: "controls" })
  public controls = false;

  @property({ type: Boolean, attribute: "muted" })
  public muted = false;

  @property({ type: Boolean, attribute: "autoplay" })
  public autoPlay = false;

  @property({ type: Boolean, attribute: "playsinline" })
  public playsInline = false;

  @property() public posterUrl!: string;

  @state() private _error?: string;

  // don't cache this, as we remove it on disconnects
  @query("#remote-stream") private _videoEl!: HTMLVideoElement;

  private _peerConnection?: RTCPeerConnection;

  private _remoteStream?: MediaStream;

  private _localReturnAudioTrack?: MediaStreamTrack;

  public toggleMic() {
    this._localReturnAudioTrack!.enabled =
      !this._localReturnAudioTrack!.enabled;
    this.requestUpdate();
  }

  protected override render(): TemplateResult {
    if (this._error) {
      return html`<ha-alert alert-type="error">${this._error}</ha-alert>`;
    }
    const video_html = html` <video
      id="remote-stream"
      ?autoplay=${this.autoPlay}
      .muted=${this.muted}
      ?playsinline=${this.playsInline}
      ?controls=${this.controls}
      .poster=${this.posterUrl}
      @loadeddata=${this._loadedData}
    ></video>`;
    const mic_html = !this._localReturnAudioTrack
      ? nothing
      : html`
          <div class="controls">
            <mwc-button @click=${this.toggleMic} halign id="toggle_mic">
              <ha-svg-icon
                .path=${this._localReturnAudioTrack!.enabled
                  ? mdiMicrophone
                  : mdiMicrophoneOff}
              ></ha-svg-icon>
              ${this._localReturnAudioTrack!.enabled
                ? "Turn off mic"
                : "Turn on mic"}
            </mwc-button>
          </div>
        `;
    return html`${video_html}${mic_html}`;
  }

  public override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      this._startWebRtc();
    }
  }

  public override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanUp();
  }

  protected override updated(changedProperties: PropertyValues<this>) {
    if (!changedProperties.has("entityid")) {
      return;
    }
    if (!this._videoEl) {
      return;
    }
    this._startWebRtc();
  }

  private async _startWebRtc(): Promise<void> {
    this._error = undefined;

    let peer_configuration;
    const web_rtc_config = await fetchWebRtcConfig(this.hass!, this.entityid);
    if (web_rtc_config && web_rtc_config.rtc_configuration) {
      peer_configuration = web_rtc_config.rtc_configuration;
    } else {
      peer_configuration = await this._fetchPeerConfiguration();
    }
    const peerConnection = new RTCPeerConnection(peer_configuration);

    // Some cameras (such as nest) require a data channel to establish a stream
    // however, not used by any integrations.
    if (web_rtc_config && web_rtc_config.create_data_channel === true) {
      peerConnection.createDataChannel("dataSendChannel");
    }

    // If the stream supports two way audio and the client is configured to allow it
    // N.B. connections must be secure for microphone access.
    if (
      web_rtc_config &&
      web_rtc_config.audio_direction === "sendrecv" &&
      navigator.mediaDevices
    ) {
      const tracks = await this.getMediaTracks("user", {
        video: false,
        audio: true,
      });
      if (tracks && tracks.length > 0) {
        this._localReturnAudioTrack = tracks[0];
        // Start with mic off
        this._localReturnAudioTrack.enabled = false;
      }
      peerConnection.addTransceiver(this._localReturnAudioTrack!, {
        direction: "sendrecv",
      });
    } else {
      peerConnection.addTransceiver("audio", { direction: "recvonly" });
    }
    peerConnection.addTransceiver("video", { direction: "recvonly" });
    const offerOptions: RTCOfferOptions = {
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    };
    const offer: RTCSessionDescriptionInit =
      await peerConnection.createOffer(offerOptions);
    await peerConnection.setLocalDescription(offer);

    let candidates = ""; // Build an Offer SDP string with ice candidates
    const iceResolver = new Promise<void>((resolve) => {
      peerConnection.addEventListener("icecandidate", async (event) => {
        if (!event.candidate) {
          resolve(); // Gathering complete
          return;
        }
        candidates += `a=${event.candidate.candidate}\r\n`;
      });
    });
    await iceResolver;
    const offer_sdp = offer.sdp! + candidates;

    let webRtcAnswer: WebRtcAnswer;
    try {
      webRtcAnswer = await handleWebRtcOffer(
        this.hass,
        this.entityid,
        offer_sdp
      );
    } catch (err: any) {
      this._error = "Failed to start WebRTC stream: " + err.message;
      peerConnection.close();
      return;
    }

    // Setup callbacks to render remote stream once media tracks are discovered.
    const remoteStream = new MediaStream();
    peerConnection.addEventListener("track", (event) => {
      remoteStream.addTrack(event.track);
      this._videoEl.srcObject = remoteStream;
    });
    this._remoteStream = remoteStream;

    // Initiate the stream with the remote device
    const remoteDesc = new RTCSessionDescription({
      type: "answer",
      sdp: webRtcAnswer.answer,
    });
    try {
      await peerConnection.setRemoteDescription(remoteDesc);
    } catch (err: any) {
      this._error = "Failed to connect WebRTC stream: " + err.message;
      peerConnection.close();
      return;
    }
    this._peerConnection = peerConnection;
  }

  private async getMediaTracks(media, constraints) {
    try {
      const stream =
        media === "user"
          ? await navigator.mediaDevices.getUserMedia(constraints)
          : await navigator.mediaDevices.getDisplayMedia(constraints);
      return stream.getTracks();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(e);
      return [];
    }
  }

  private async _fetchPeerConfiguration(): Promise<RTCConfiguration> {
    if (!isComponentLoaded(this.hass!, "rtsp_to_webrtc")) {
      return {};
    }
    const settings = await fetchWebRtcSettings(this.hass!);
    if (!settings || !settings.stun_server) {
      return {};
    }
    return {
      iceServers: [
        {
          urls: [`stun:${settings.stun_server!}`],
        },
      ],
    };
  }

  private async _cleanUp() {
    if (this._remoteStream) {
      this._remoteStream.getTracks().forEach((track) => {
        track.stop();
      });
      this._remoteStream = undefined;
    }
    if (this._localReturnAudioTrack) {
      this._localReturnAudioTrack.stop();
    }
    if (this._videoEl) {
      this._videoEl.removeAttribute("src");
      this._videoEl.load();
    }
    if (this._peerConnection) {
      this._peerConnection.close();
      this._peerConnection = undefined;
      await closeWebRtcStream(this.hass, this.entityid);
    }
  }

  private _loadedData() {
    // @ts-ignore
    fireEvent(this, "load");
  }

  static get styles(): CSSResultGroup {
    return css`
      :host,
      video {
        display: block;
      }

      video {
        width: 100%;
        max-height: var(--video-max-height, calc(100vh - 97px));
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-web-rtc-player": HaWebRtcPlayer;
  }
}
