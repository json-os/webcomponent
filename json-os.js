/**
 * json-os.js — Zero-dependency web component for JSON-LD panes
 *
 * Replaces solid-shim/mashlib.min.js (1.4MB) with ~4KB.
 * Implements the @view proposal for self-rendering JSON-LD documents.
 * See: https://github.com/w3c/json-ld-syntax/issues/384
 *
 * Usage:
 *   <script src="json-os.js"></script>
 *   — auto-detects <script type="application/ld+json"> with @view and renders
 *
 *   <json-os src="data.jsonld"></json-os>
 *   — fetches and renders external JSON-LD
 *
 *   <json-os>
 *     <script type="application/ld+json">{ ... }</script>
 *   </json-os>
 *   — renders inline JSON-LD
 */

// ── Minimal $rdf shim ──────────────────────────────────────────────

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

function sym(uri) {
  return { uri, value: uri, termType: 'NamedNode' }
}

function Namespace(base) {
  const ns = (name) => sym(base + name)
  ns.uri = base
  return ns
}

function literal(val) {
  return { value: String(val), termType: 'Literal' }
}

const $rdf = { sym, Namespace, literal }
window.$rdf = $rdf

// ── Minimal RDF Store ───────────────────────────────────────────────

function createStore() {
  const triples = []

  function normalize(uri) {
    // Treat http and https schema.org as equivalent
    if (typeof uri === 'string') {
      return uri.replace('https://schema.org/', 'http://schema.org/')
    }
    return uri
  }

  function matchUri(a, b) {
    const uriA = typeof a === 'object' && a !== null ? a.uri || a.value : a
    const uriB = typeof b === 'object' && b !== null ? b.uri || b.value : b
    return normalize(uriA) === normalize(uriB)
  }

  return {
    add(s, p, o) {
      triples.push({ s, p, o })
    },

    // First matching object as string, or null
    anyValue(s, p) {
      for (const t of triples) {
        if (matchUri(t.s, s) && matchUri(t.p, p)) {
          if (typeof t.o === 'object' && t.o !== null) return t.o.value || t.o.uri || null
          return t.o != null ? String(t.o) : null
        }
      }
      return null
    },

    // First matching object as node, or null
    any(s, p) {
      for (const t of triples) {
        if (matchUri(t.s, s) && matchUri(t.p, p)) {
          if (typeof t.o === 'object' && t.o !== null) return t.o
          // Wrap literal in an object with .value
          return t.o != null ? { value: String(t.o), uri: undefined, termType: 'Literal' } : null
        }
      }
      return null
    },

    // All matching objects
    each(s, p) {
      const results = []
      for (const t of triples) {
        if (matchUri(t.s, s) && matchUri(t.p, p)) {
          if (typeof t.o === 'object' && t.o !== null) {
            results.push(t.o)
          } else if (t.o != null) {
            results.push({ value: String(t.o), uri: undefined, termType: 'Literal' })
          }
        }
      }
      return results
    },

    // All rdf:type URIs for subject → { [uri]: true }
    findTypeURIs(s) {
      const result = {}
      for (const t of triples) {
        if (matchUri(t.s, s) && normalize(t.p.uri || t.p) === RDF_TYPE) {
          const uri = typeof t.o === 'object' ? t.o.uri : t.o
          if (uri) {
            result[uri] = true
            // Also index the alternate http/https variant
            if (uri.startsWith('http://schema.org/')) {
              result[uri.replace('http://', 'https://')] = true
            } else if (uri.startsWith('https://schema.org/')) {
              result[uri.replace('https://', 'http://')] = true
            }
          }
        }
      }
      return result
    },

    // Expose triples for debugging
    get _triples() { return triples }
  }
}

// ── JSON-LD → Store parser ──────────────────────────────────────────

function resolvePrefix(key, context) {
  if (key.startsWith('@')) return null
  for (const [prefix, base] of Object.entries(context)) {
    if (key.startsWith(prefix + ':')) {
      return key.replace(prefix + ':', base)
    }
  }
  // If it's already a full URI, return as-is
  if (key.startsWith('http://') || key.startsWith('https://')) return key
  return key
}

function parseJsonLdToStore(jsonld, baseUri, store) {
  // Build context map from @context
  const ctx = {}
  if (jsonld['@context']) {
    const raw = jsonld['@context']
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      Object.entries(raw).forEach(([k, v]) => {
        if (typeof v === 'string') ctx[k] = v
      })
    }
  }

  const rootId = baseUri + (jsonld['@id'] || '#thing')

  function addTriples(node, subjectUri) {
    const subject = sym(subjectUri)

    // Add @type
    if (node['@type']) {
      const typeUri = resolvePrefix(node['@type'], ctx) || node['@type']
      store.add(subject, sym(RDF_TYPE), sym(typeUri))
    }

    // Add properties
    Object.entries(node).forEach(([key, val]) => {
      if (key.startsWith('@')) return
      const predUri = resolvePrefix(key, ctx)
      if (!predUri) return
      const pred = sym(predUri)

      if (Array.isArray(val)) {
        val.forEach((item, i) => {
          if (typeof item === 'object' && item !== null && !item['@id']) {
            const blankId = subjectUri + '_' + key.split(':').pop() + '_' + i
            store.add(subject, pred, sym(blankId))
            addTriples(item, blankId)
          } else if (typeof item === 'object' && item !== null && item['@id']) {
            const uri = item['@id'].startsWith('http') ? item['@id'] : baseUri + item['@id']
            store.add(subject, pred, sym(uri))
          } else {
            store.add(subject, pred, item)
          }
        })
      } else if (typeof val === 'object' && val !== null && val['@id']) {
        const uri = val['@id'].startsWith('http') ? val['@id'] : baseUri + val['@id']
        store.add(subject, pred, sym(uri))
      } else if (typeof val === 'object' && val !== null) {
        const blankId = subjectUri + '_' + key.split(':').pop()
        store.add(subject, pred, sym(blankId))
        addTriples(val, blankId)
      } else {
        store.add(subject, pred, val)
      }
    })
  }

  addTriples(jsonld, rootId)
  return sym(rootId)
}

// ── Render engine ───────────────────────────────────────────────────

async function renderView(options = {}) {
  // Find JSON-LD
  const scriptEl = options.scriptElement ||
    document.querySelector('script[type="application/ld+json"]')
  if (!scriptEl) return null

  let jsonld
  try {
    jsonld = JSON.parse(scriptEl.textContent || '')
  } catch (e) {
    console.error('[json-os] Invalid JSON-LD:', e)
    return null
  }

  // Parse
  const baseUri = options.baseUri || window.location.href.split('#')[0]
  const store = createStore()
  const subject = parseJsonLdToStore(jsonld, baseUri, store)

  // Load @view pane
  if (!jsonld['@view']) {
    console.warn('[json-os] No @view in JSON-LD')
    return { subject, store }
  }

  let pane
  try {
    const mod = await import(/* webpackIgnore: true */ jsonld['@view'])
    pane = mod.default || mod
  } catch (err) {
    console.error('[json-os] Failed to load @view:', jsonld['@view'], err)
    return { subject, store }
  }

  // Render
  const context = {
    dom: document,
    session: { store }
  }

  const target = options.target || (() => {
    const div = document.createElement('div')
    div.id = 'json-os-view'
    scriptEl.parentNode.insertBefore(div, scriptEl.nextSibling)
    return div
  })()

  try {
    const rendered = pane.render(subject, context)
    target.appendChild(rendered)
  } catch (e) {
    console.error('[json-os] Render error:', e)
    target.innerHTML = `<p style="color:#dc2626;padding:1rem">json-os render error: ${e.message}</p>`
  }

  return { subject, store, pane }
}

// ── Web Component ───────────────────────────────────────────────────

class JsonOsElement extends HTMLElement {
  async connectedCallback() {
    const src = this.getAttribute('src')

    if (src) {
      // External JSON-LD
      try {
        const res = await fetch(src)
        const text = await res.text()
        const script = document.createElement('script')
        script.type = 'application/ld+json'
        script.textContent = text
        this.insertBefore(script, this.firstChild)
      } catch (e) {
        console.error('[json-os] Failed to fetch:', src, e)
        return
      }
    }

    const scriptEl = this.querySelector('script[type="application/ld+json"]')
    if (!scriptEl) return

    await renderView({
      scriptElement: scriptEl,
      target: this,
      baseUri: src ? new URL(src, window.location.href).href.split('#')[0] : undefined
    })
  }
}

customElements.define('json-os', JsonOsElement)

// ── Auto-render (backward compat with solid-shim) ───────────────────

if (typeof document !== 'undefined') {
  // Wait for DOM ready
  const init = () => {
    const scriptEl = document.querySelector('script[type="application/ld+json"]')
    if (scriptEl) {
      try {
        const data = JSON.parse(scriptEl.textContent || '')
        if (data['@view']) {
          // Only auto-render if not inside a <json-os> element
          if (!scriptEl.closest('json-os')) {
            renderView({ scriptElement: scriptEl })
          }
        }
      } catch (e) { /* skip */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
}

// ── Exports ─────────────────────────────────────────────────────────

export { $rdf, createStore, parseJsonLdToStore, renderView }
