export { open } from "./pty.js";
export type { ExitInfo, KillOptions, Pty, PtyOptions } from "./pty.js";

export {
    SUPPORTED,
    helperFileName,
    helperPath,
    isSupported,
    packageRoot,
    platformKey,
    unpackedPath,
} from "./helper-path.js";

export {
    FrameDecoder,
    HEADER_BYTES,
    MAX_FRAME_BYTES,
    clampDimension,
    decodeKilled,
    encodeKill,
    encodeResize,
    encodeSpawn,
    frame,
} from "./protocol.js";
export type { DecodedFrame, KillOutcome, SpawnRequest } from "./protocol.js";
