/**
 * Loader entry for the browser half (`exports["./client"]`). The Loader only
 * serves a client bundle for a row naming the package root, so this row exists
 * to mount it; turns run in `./driver`, models are listed by `./catalog`.
 */
export const name = 'dsh-aio-agent'

export function apply() {}
