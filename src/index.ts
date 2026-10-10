export { open } from "./pty.js";
export type { Pty, PtyOptions } from "./pty.js";

export {
    SUPPORTED,
    helperFileName,
    helperPath,
    isSupported,
    packageRoot,
    platformKey,
} from "./helper-path.js";

export {
    FrameDecoder,
    HEADER_BYTES,
    MAX_FRAME_BYTES,
    clampDimension,
    encodeResize,
    encodeSpawn,
    frame,
} from "./protocol.js";
export type { DecodedFrame, SpawnRequest } from "./protocol.js";
