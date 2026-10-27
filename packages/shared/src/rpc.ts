/**
 * The version of the RPC contract between a window and an engine: the methods, their parameters (backend/rpc-params.ts) and their
 * answers. Raise it when a method is renamed or removed, or a parameter or an answer changes in a way an older window would
 * misread (adding a method or an optional parameter does not). `app.info` answers it and the window checks it when it connects;
 * the bridge refuses a page that sends another one.
 */
export const RPC_VERSION = 1;
