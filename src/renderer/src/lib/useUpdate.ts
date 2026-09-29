import { useEffect, useState } from 'react'
import { toast } from '../components/Toast'

const install = (): void => {
  window.api.installUpdate().catch((e) => toast(`Update failed: ${(e as Error).message}`, true))
}

/** "Check for updates" from the command palette: checks now and says what it found. */
export function checkForUpdates(): void {
  toast('Checking for updates…')
  window.api.checkForUpdates().then(
    (result) => {
      if (result.state === 'dev') toast('Updates only apply to the installed app')
      else if (result.state === 'current') toast(`JDB ${result.version} is up to date`)
      else if (result.state === 'downloading') toast(`Downloading JDB ${result.version}. You'll be told when it's ready.`)
      else if (result.state === 'ready') toast(`JDB ${result.version} is ready. It installs when you close JDB.`, false, { label: 'Restart now', run: install })
      else toast(`Couldn't check for updates: ${result.error}`, true)
    },
    (e) => toast(`Couldn't check for updates: ${(e as Error).message}`, true)
  )
}

/**
 * The version of a downloaded update waiting to install, or null, and a way to restart into it.
 * Announces the update with a toast when it arrives; one downloaded before the page loaded is
 * picked up without a toast.
 */
export function useUpdate(): { version: string | null; install(): void } {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    window.api.readyUpdate().then((v) => v && setVersion(v), () => undefined)
    return window.api.onUpdateReady((v) => {
      setVersion(v)
      toast(`JDB ${v} is ready. It installs when you close JDB.`, false, { label: 'Restart now', run: install })
    })
  }, [])
  return { version, install }
}
