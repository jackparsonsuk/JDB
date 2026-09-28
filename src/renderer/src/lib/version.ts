/** The version shown in the UI; dev builds are marked so they aren't mistaken for the installed app. */
export const appVersion = `v${__APP_VERSION__}${import.meta.env.DEV ? ' (dev)' : ''}`
