import { useEffect, useState } from 'react'
import { toast } from '../components/Toast'

const install = (): void => {
  window.api.installUpdate().catch((e) => toast(`Update failed: ${(e as Error).message}`, true))
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
