import { shell } from 'electron'
import {
  InteractionRequiredAuthError, PublicClientApplication, type AccountInfo, type AuthenticationResult, type ICachePlugin
} from '@azure/msal-node'
import type { AccessToken } from '@azure/identity'
import { readTokenCache, writeTokenCache } from '../store'

/**
 * Entra browser sign-in with a token cache that survives restarts. After the first sign-in,
 * later launches get tokens silently from the cached refresh token instead of reopening the
 * browser. The cache is encrypted on disk by the store, like saved passwords.
 */

/** The public client Azure CLI and @azure/identity's browser credential use; no app registration needed. */
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'

const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(context) {
    const data = readTokenCache()
    if (data) context.tokenCache.deserialize(data)
  },
  async afterCacheAccess(context) {
    if (context.cacheHasChanged) writeTokenCache(context.tokenCache.serialize())
  }
}

const clients = new Map<string, PublicClientApplication>()
/** Sign-ins in progress per tenant, so two connections don't open two browser tabs. */
const signingIn = new Map<string, Promise<AuthenticationResult>>()

function client(tenantId: string | undefined): PublicClientApplication {
  const key = tenantId ?? ''
  let pca = clients.get(key)
  if (!pca) {
    pca = new PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: `https://login.microsoftonline.com/${tenantId || 'organizations'}` },
      cache: { cachePlugin }
    })
    clients.set(key, pca)
  }
  return pca
}

/** The cached account for this tenant, or the only one if no tenant was given. */
function pickAccount(accounts: AccountInfo[], tenantId: string | undefined): AccountInfo | undefined {
  if (tenantId) return accounts.find((a) => a.tenantId === tenantId)
  return accounts.length === 1 ? accounts[0] : undefined
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><title>JDB</title><body style="font:15px 'Segoe UI',sans-serif;padding:40px"><h2>${title}</h2><p>${body}</p></body>`

export async function getEntraToken(scope: string, tenantId: string | undefined): Promise<AccessToken> {
  const pca = client(tenantId)
  const scopes = [scope]
  const account = pickAccount(await pca.getTokenCache().getAllAccounts(), tenantId)
  if (account) {
    try {
      return toAccessToken(await pca.acquireTokenSilent({ account, scopes }))
    } catch (error) {
      // An expired or revoked refresh token needs the browser again; anything else is a real failure.
      if (!(error instanceof InteractionRequiredAuthError)) throw error
    }
  }

  const key = tenantId ?? ''
  let pending = signingIn.get(key)
  if (!pending) {
    pending = pca.acquireTokenInteractive({
      scopes,
      openBrowser: async (url) => {
        await shell.openExternal(url)
      },
      successTemplate: PAGE('Signed in to JDB', 'You can close this tab.'),
      errorTemplate: PAGE('Sign-in failed', 'Close this tab and try again in JDB.')
    }).finally(() => signingIn.delete(key))
    signingIn.set(key, pending)
  }
  return toAccessToken(await pending)
}

/** Forgets every cached Entra sign-in, so the next connection asks again. */
export async function signOutEntra(): Promise<void> {
  for (const pca of clients.values()) {
    const cache = pca.getTokenCache()
    for (const account of await cache.getAllAccounts()) await cache.removeAccount(account)
  }
  writeTokenCache(null)
}

function toAccessToken(result: AuthenticationResult): AccessToken {
  if (!result.accessToken || !result.expiresOn) throw new Error('Entra sign-in returned no access token')
  return { token: result.accessToken, expiresOnTimestamp: result.expiresOn.getTime() }
}
