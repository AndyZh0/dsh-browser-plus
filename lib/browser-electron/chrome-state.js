/**
 * Versioned state exchanged between the parent process and the page chrome it
 * injects into every view. Keeping the payload declarative makes it possible
 * to update one task or one trail entry without rebuilding the whole workspace.
 * @module dsh-browser-plus/browser-electron/chrome-state
 */
export function createBootstrap(state) {
    return { kind: 'bootstrap', ...state };
}
export function createPatch(epoch, revision, operations) {
    return { kind: 'patch', epoch, revision, operations };
}
