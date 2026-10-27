/**
 * The parts of the engine that only make sense on someone's own computer: they start browsers and terminals, install a root
 * certificate into the operating system, switch the system proxy. They read the user's profile folders and run programs, so a server
 * host never imports this entry (`@testpion/core/desktop`); the desktop app and the CLI do. Everything else is in `@testpion/core`.
 */
export * from './debugger/capture.js';
export * from './debugger/certificate.js';
