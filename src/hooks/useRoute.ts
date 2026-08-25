import { useEffect, useState } from 'react'

/**
 * A deliberately tiny hash-based router — no react-router dependency,
 * since the app only needs a handful of top-level views plus one
 * parameterised route (client dossier). Keeps the stack light (per the
 * developer-agent ground rules) while still giving every view a bookmarkable
 * URL.
 */
export interface Route {
  view: string
  param?: string
}

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '')
  const [view, param] = hash.split('/')
  return { view: view || 'werklijst', param }
}

export function useRoute(): [Route, (view: string, param?: string) => void] {
  const [route, setRoute] = useState<Route>(parseHash())

  useEffect(() => {
    function onHashChange() {
      setRoute(parseHash())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  function navigate(view: string, param?: string) {
    window.location.hash = param ? `/${view}/${param}` : `/${view}`
  }

  return [route, navigate]
}
