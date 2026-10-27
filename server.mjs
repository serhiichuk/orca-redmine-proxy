// Jira-Server-shaped proxy for Redmine (reads and writes). Node 22, stdlib only.
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const REDMINE_URL = (process.env.REDMINE_URL || '').replace(/\/+$/, '')
const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const KEY_PREFIX = process.env.KEY_PREFIX || 'RM'

class HttpError extends Error {
  constructor(status, message, messages = [message]) {
    super(message)
    this.status = status
    this.messages = messages
  }
}

// ---------- pure functions (exported for test.mjs) ----------

/** "RM-122922" -> 122922. Ignores the prefix. Returns null if no trailing -<digits>. */
export function parseKey(key) {
  const m = /-(\d+)$/.exec(String(key))
  return m ? Number(m[1]) : null
}

export function projectKey(identifier) {
  return String(identifier).toUpperCase().replace(/[^A-Za-z0-9_]/g, '_')
}

export function mapUser(u) {
  if (!u || u.id == null) return null
  const name = u.name ?? [u.firstname, u.lastname].filter(Boolean).join(' ')
  return { name: String(u.id), key: String(u.id), displayName: name || 'Unknown' }
}

function jiraStatus(st, closed) {
  return {
    id: String(st.id),
    name: st.name,
    statusCategory: closed ? { key: 'done', name: 'Done' } : { key: 'indeterminate', name: 'In Progress' }
  }
}

/**
 * Redmine issue -> Jira v2 issue.
 * opts: { prefix, closedIds: Set<number> (fallback when status.is_closed is absent),
 *         projectKeys: Map<projectId, identifier> }
 */
export function mapIssue(issue, { prefix = KEY_PREFIX, closedIds = new Set(), projectKeys = new Map() } = {}) {
  const st = issue.status || {}
  const closed = typeof st.is_closed === 'boolean' ? st.is_closed : closedIds.has(st.id)
  const pr = issue.project || {}
  const ident = projectKeys.get(pr.id)
  const fields = {
    summary: issue.subject,
    description: issue.description ? String(issue.description) : null,
    status: jiraStatus(st, closed),
    project: { id: String(pr.id), key: ident ? projectKey(ident) : `P${pr.id}`, name: pr.name },
    issuetype: { id: String(issue.tracker?.id), name: issue.tracker?.name, subtask: Boolean(issue.parent) },
    priority: issue.priority ? { id: String(issue.priority.id), name: issue.priority.name } : null,
    assignee: mapUser(issue.assigned_to),
    reporter: mapUser(issue.author),
    labels: [],
    created: issue.created_on,
    updated: issue.updated_on
  }
  if (issue.parent) {
    fields.parent = { id: String(issue.parent.id), key: `${prefix}-${issue.parent.id}`, fields: { summary: '' } }
  }
  return { id: String(issue.id), key: `${prefix}-${issue.id}`, fields }
}

export function mapComments(issue, startAt = 0, maxResults = 100) {
  const all = (issue.journals || []).filter((j) => j.notes && j.notes.trim())
  const comments = all.slice(startAt, startAt + maxResults).map((j) => ({
    id: String(j.id),
    body: j.notes,
    created: j.created_on,
    updated: j.updated_on || j.created_on,
    author: mapUser(j.user)
  }))
  return { startAt, maxResults, total: all.length, comments }
}

// Replace quoted strings with same-length filler so regexes cannot match inside them.
const mask = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => 'x'.repeat(m.length))
const unquote = (s) => s.replace(/\\(.)/g, '$1')

function splitOn(s, re) {
  const parts = []
  let last = 0
  for (const m of mask(s).matchAll(new RegExp(re, 'gi'))) {
    parts.push(s.slice(last, m.index))
    last = m.index + m[0].length
  }
  parts.push(s.slice(last))
  return parts
}

/**
 * JQL (only what Orca generates) -> ordered [key, value] pairs for Redmine /issues.json.
 * statuses: [{id, name}] used to resolve `status in (...)`.
 * Always emits the f[]/op[]/v[] form: Redmine ignores shortcut params (assigned_to_id=me ...)
 * as soon as any f[] is present, so one form for every clause is the only safe choice.
 */
export function jqlToParams(jql, statuses = []) {
  const [clausePart, orderPart = ''] = splitOn(jql.trim(), /(?:^|\s)order\s+by\s+/i)
  const filters = new Map() // field -> [op, values]
  let text = null
  for (const raw of splitOn(clausePart, /\s+and\s+/i)) {
    const c = raw.trim()
    if (!c) continue
    let m
    if (/^assignee\s*=\s*currentUser\(\)$/i.test(c)) filters.set('assigned_to_id', ['=', ['me']])
    else if (/^reporter\s*=\s*currentUser\(\)$/i.test(c)) filters.set('author_id', ['=', ['me']])
    else if ((m = /^statusCategory\s*(!=|=)\s*"?done"?$/i.exec(c))) {
      if (!filters.has('status_id')) filters.set('status_id', [m[1] === '=' ? 'c' : 'o', []])
    } else if ((m = /^status\s+in\s*\((.*)\)$/is.exec(c))) {
      const names = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unquote(x[1]).toLowerCase())
      const ids = statuses.filter((s) => names.includes(String(s.name).toLowerCase())).map((s) => String(s.id))
      filters.set('status_id', ['=', ids.length ? ids : ['0']]) // unknown names match nothing
    } else if ((m = /^text\s*~\s*"((?:[^"\\]|\\.)*)"$/i.exec(c))) {
      text = unquote(m[1]).replace(/\*/g, '').trim()
    } else if ((m = /^key\s*=\s*"?([A-Za-z][A-Za-z0-9_]*-\d+)"?$/i.exec(c))) {
      filters.set('issue_id', ['=', [String(parseKey(m[1]))]])
    } else if (/^sprint\s+in\s+openSprints\(\)$/i.test(c)) {
      // Redmine has no sprints: ignored.
    } else throw new HttpError(400, `Unsupported JQL clause: ${c}`)
  }
  if (!filters.has('status_id')) filters.set('status_id', ['*', []])
  if (text) filters.set('subject', ['~', [text]])

  let sort = 'updated_on:desc'
  const o = orderPart.trim()
  if (o) {
    const m = /^(updated|created)(?:\s+(asc|desc))?$/i.exec(o)
    if (!m) throw new HttpError(400, `Unsupported JQL ORDER BY: ${o}`)
    sort = `${m[1].toLowerCase() === 'created' ? 'created_on' : 'updated_on'}:${(m[2] || 'asc').toLowerCase()}`
  }

  const pairs = []
  for (const [field, [op, values]] of filters) {
    pairs.push(['f[]', field], [`op[${field}]`, op])
    for (const v of values) pairs.push([`v[${field}][]`, v])
  }
  pairs.push(['sort', sort])
  return pairs
}

// ---------- Redmine access ----------

// One state object per server: Redmine base URL plus caches. ponytail: caches never expire per key; restart to refresh.
const newRedmine = (url) => ({ url: url.replace(/\/+$/, ''), statuses: null, projects: null, keys: new Map() })

async function redmine(rm, method, path, token, body) {
  let res
  try {
    res = await fetch(rm.url + path, {
      method,
      headers: { 'X-Redmine-API-Key': token, Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    throw new HttpError(502, 'Redmine is unreachable')
  }
  if (res.status === 422) {
    const { errors } = await res.json().catch(() => ({}))
    throw new HttpError(400, 'Redmine rejected the request', Array.isArray(errors) && errors.length ? errors.map(String) : undefined)
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new HttpError(res.status, `Redmine returned ${res.status}`)
  if (!res.ok) throw new HttpError(502, `Redmine returned ${res.status}`)
  return res.status === 204 ? null : res.json()
}
const redmineGet = (rm, path, token) => redmine(rm, 'GET', path, token)

/** Collect every page of a Redmine list (limit/offset/total_count). */
async function redminePages(rm, path, listKey, token) {
  const out = []
  for (let offset = 0, guard = 0; guard < 100; guard++) {
    const data = await redmineGet(rm, `${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`, token)
    const items = data[listKey] || []
    out.push(...items)
    offset += items.length
    if (!items.length || offset >= data.total_count) break
  }
  return out
}

async function getStatuses(rm, token) {
  if (!rm.statuses || Date.now() - rm.statuses.at > 10 * 60_000) {
    rm.statuses = { at: Date.now(), list: (await redmineGet(rm, '/issue_statuses.json', token)).issue_statuses }
  }
  return rm.statuses.list
}

/** All projects, cached 10 minutes. Also fills the id -> identifier cache that the read path uses. */
async function getProjects(rm, token) {
  if (!rm.projects || Date.now() - rm.projects.at > 10 * 60_000) {
    const list = await redminePages(rm, '/projects.json', 'projects', token)
    for (const p of list) rm.keys.set(p.id, p.identifier)
    rm.projects = { at: Date.now(), list }
  }
  return rm.projects.list
}

/** Numeric id, or a Jira-style project key (as returned by GET /project), -> Redmine project id. */
async function resolveProjectId(rm, ref, token) {
  if (/^\d+$/.test(ref)) return Number(ref)
  const want = String(ref).toUpperCase()
  const p = (await getProjects(rm, token)).find((x) => projectKey(x.identifier) === want)
  if (!p) throw new HttpError(404, `Project does not exist: ${ref}`)
  return p.id
}

async function projectKeys(rm, issues, token) {
  const ids = [...new Set(issues.map((i) => i.project?.id).filter((id) => id != null && !rm.keys.has(id)))]
  await Promise.all(
    ids.map(async (id) => {
      try {
        rm.keys.set(id, (await redmineGet(rm, `/projects/${id}.json`, token)).project.identifier)
      } catch (e) {
        if (e.status === 401) throw e // otherwise fall back to P<id>
      }
    })
  )
  return rm.keys
}

async function mapWithContext(rm, issues, token) {
  const closedIds = new Set((await getStatuses(rm, token)).filter((s) => s.is_closed).map((s) => s.id))
  const pk = await projectKeys(rm, issues, token)
  return issues.map((i) => mapIssue(i, { closedIds, projectKeys: pk }))
}

// ---------- HTTP layer ----------

const clamp = (n, lo, hi, dflt) => Math.min(Math.max(Number.isFinite(n) ? n : dflt, lo), hi)

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > 1_000_000) throw new HttpError(413, 'Request body too large')
    chunks.push(c)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
}

function issueId(rawKey) {
  const id = parseKey(decodeURIComponent(rawKey))
  if (id == null) throw new HttpError(404, `Issue does not exist: ${rawKey}`)
  return id
}

/** Jira body {name: "<id>"|null} / Redmine assigned_to_id value. null unassigns (Redmine wants ""). */
function assigneeId(name) {
  if (name === null) return ''
  if (name === undefined) throw new HttpError(400, 'name is required (use null to unassign)')
  if (!/^\d+$/.test(String(name))) throw new HttpError(400, 'name must be a Redmine user id or null')
  return Number(name)
}

const NO_CONTENT = { status: 204 }
const API = '/rest/api/2'

async function route(rm, req, url) {
  const { method } = req
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1]
  const needAuth = () => {
    if (!token) throw new HttpError(401, 'Authentication required')
    return token
  }
  const get = (path) => redmineGet(rm, path, token)
  const send = (verb, path, body) => redmine(rm, verb, path, token, body)
  const param = (...names) => names.map((n) => url.searchParams.get(n)).find((v) => v != null && v !== '')
  let m

  if (method === 'GET' && (m = /^\/browse\/([^/]+)$/.exec(p))) {
    return { status: 302, headers: { Location: `${rm.url}/issues/${issueId(m[1])}` } }
  }
  // One fake board orders Orca's status columns by Redmine's admin status order.
  // Unnamed columns only rank statuses; named ones would add an empty lane per status.
  if (method === 'GET' && p === '/rest/agile/1.0/board') {
    needAuth()
    return { status: 200, body: { startAt: 0, maxResults: 1, total: 1, isLast: true, values: [{ id: 1, name: 'Redmine' }] } }
  }
  if (method === 'GET' && p === '/rest/agile/1.0/board/1/configuration') {
    const columns = (await getStatuses(rm, needAuth())).map((s) => ({ name: '', statuses: [{ id: String(s.id) }] }))
    return { status: 200, body: { columnConfig: { columns } } }
  }
  if (method === 'GET' && [`${API}/field`, `${API}/filter/favourite`].includes(p)) {
    needAuth()
    return { status: 200, body: [] }
  }
  if (method === 'GET' && p === `${API}/myself`) {
    needAuth()
    const u = (await get('/users/current.json')).user
    const me = mapUser(u)
    return { status: 200, body: { ...me, ...(u.mail ? { emailAddress: u.mail } : {}) } }
  }
  if (method === 'POST' && p === `${API}/search`) {
    needAuth()
    const body = await readJson(req)
    if (typeof body.jql !== 'string') throw new HttpError(400, 'jql is required')
    const limit = clamp(Number(body.maxResults), 1, 100, 50)
    const offset = clamp(Number(body.startAt), 0, Infinity, 0)
    const params = jqlToParams(body.jql, await getStatuses(rm, token)) // 400 before any issue request
    params.push(['limit', String(limit)], ['offset', String(offset)])
    const data = await get(`/issues.json?${new URLSearchParams(params)}`)
    return { status: 200, body: { startAt: offset, maxResults: limit, total: data.total_count, issues: await mapWithContext(rm, data.issues, token) } }
  }
  if (method === 'GET' && (m = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(p))) {
    needAuth()
    const { issue } = await get(`/issues/${issueId(m[1])}.json`)
    return { status: 200, body: (await mapWithContext(rm, [issue], token))[0] }
  }
  if (method === 'GET' && (m = /^\/rest\/api\/2\/issue\/([^/]+)\/comment$/.exec(p))) {
    needAuth()
    const { issue } = await get(`/issues/${issueId(m[1])}.json?include=journals`)
    const startAt = clamp(Number(url.searchParams.get('startAt')), 0, Infinity, 0)
    const maxResults = clamp(Number(url.searchParams.get('maxResults')), 1, 1000, 100)
    return { status: 200, body: mapComments(issue, startAt, maxResults) }
  }

  // ----- transitions: Redmine "transition" = move to an allowed status -----
  if (method === 'GET' && (m = /^\/rest\/api\/2\/issue\/([^/]+)\/transitions$/.exec(p))) {
    needAuth()
    const { issue } = await get(`/issues/${issueId(m[1])}.json?include=allowed_statuses`)
    const transitions = (issue.allowed_statuses || [])
      .filter((s) => s.id !== issue.status?.id)
      .map((s) => ({ id: String(s.id), name: s.name, to: jiraStatus(s, s.is_closed === true) }))
    return { status: 200, body: { transitions } }
  }
  if (method === 'POST' && (m = /^\/rest\/api\/2\/issue\/([^/]+)\/transitions$/.exec(p))) {
    needAuth()
    const id = issueId(m[1])
    const body = await readJson(req)
    const statusId = Number(body.transition?.id)
    if (!Number.isInteger(statusId)) throw new HttpError(400, 'transition.id is required')
    const notes = body.update?.comment?.[0]?.add?.body
    // body.fields (transition screen fields) is ignored: Redmine has no equivalent.
    await send('PUT', `/issues/${id}.json`, { issue: { status_id: statusId, ...(notes ? { notes } : {}) } })
    return NO_CONTENT
  }

  // ----- issue edits -----
  if (method === 'PUT' && (m = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(p))) {
    needAuth()
    const id = issueId(m[1])
    const { fields = {}, update = {} } = await readJson(req)
    if (fields.labels !== undefined || update.labels !== undefined) throw new HttpError(400, 'Redmine has no labels')
    const issue = {}
    if (fields.summary !== undefined) issue.subject = fields.summary
    if (fields.priority !== undefined) issue.priority_id = fields.priority === null ? '' : Number(fields.priority.id)
    if (Object.keys(issue).length) await send('PUT', `/issues/${id}.json`, { issue })
    return NO_CONTENT
  }
  if (method === 'PUT' && (m = /^\/rest\/api\/2\/issue\/([^/]+)\/assignee$/.exec(p))) {
    needAuth()
    const id = issueId(m[1])
    const { name } = await readJson(req)
    await send('PUT', `/issues/${id}.json`, { issue: { assigned_to_id: assigneeId(name) } })
    return NO_CONTENT
  }
  if (method === 'POST' && (m = /^\/rest\/api\/2\/issue\/([^/]+)\/comment$/.exec(p))) {
    needAuth()
    const id = issueId(m[1])
    const { body } = await readJson(req)
    if (typeof body !== 'string' || !body.trim()) throw new HttpError(400, 'body is required')
    await send('PUT', `/issues/${id}.json`, { issue: { notes: body } })
    // Redmine returns nothing for the new note: read the journals back and take the newest one with notes.
    const { issue } = await get(`/issues/${id}.json?include=journals`)
    const created = mapComments(issue, 0, Infinity).comments.at(-1)
    if (!created) throw new HttpError(502, 'Redmine did not return the new comment')
    return { status: 201, body: created }
  }
  if (method === 'POST' && p === `${API}/issue`) {
    needAuth()
    const { fields = {} } = await readJson(req)
    const projectId = Number(fields.project?.id)
    const trackerId = Number(fields.issuetype?.id)
    if (!Number.isInteger(projectId) || !Number.isInteger(trackerId) || typeof fields.summary !== 'string' || !fields.summary.trim()) {
      throw new HttpError(400, 'project.id, issuetype.id and summary are required')
    }
    // Other fields (custom fields, priority, assignee, ...) are ignored.
    const issue = { project_id: projectId, tracker_id: trackerId, subject: fields.summary }
    if (typeof fields.description === 'string' && fields.description.trim()) issue.description = fields.description
    const created = (await send('POST', '/issues.json', { issue })).issue
    return { status: 201, body: { id: String(created.id), key: `${KEY_PREFIX}-${created.id}`, self: `${rm.url}/issues/${created.id}` } }
  }

  // ----- pickers and create metadata -----
  if (method === 'GET' && p === `${API}/priority`) {
    needAuth()
    const list = (await get('/enumerations/issue_priorities.json')).issue_priorities || []
    return { status: 200, body: list.filter((x) => x.active !== false).map((x) => ({ id: String(x.id), name: x.name })) }
  }
  if (method === 'GET' && p === `${API}/project`) {
    needAuth()
    const list = await getProjects(rm, token)
    return { status: 200, body: list.map((x) => ({ id: String(x.id), key: projectKey(x.identifier), name: x.name })) }
  }
  if (method === 'GET' && p === `${API}/user/assignable/search`) {
    needAuth()
    const issueKey = param('issueKey')
    const project = param('project')
    let projectId
    if (issueKey) projectId = (await get(`/issues/${issueId(issueKey)}.json`)).issue.project.id
    else if (project) projectId = await resolveProjectId(rm, project, token)
    else throw new HttpError(400, 'issueKey or project is required')
    const query = (param('username', 'query') || '').toLowerCase() // Server/DC sends `username`
    const limit = clamp(Number(url.searchParams.get('maxResults')), 1, 1000, 50)
    const members = await redminePages(rm, `/projects/${projectId}/memberships.json`, 'memberships', token)
    const users = members
      .filter((x) => x.user) // groups have no `user`
      .map((x) => mapUser(x.user))
      .filter((u) => u && u.displayName.toLowerCase().includes(query))
    return { status: 200, body: users.slice(0, limit) }
  }
  if (method === 'GET' && p === `${API}/user/search`) {
    needAuth()
    const query = param('username', 'query')
    const limit = clamp(Number(url.searchParams.get('maxResults')), 1, 100, 50)
    const params = new URLSearchParams({ limit: String(limit) })
    if (query && query !== '.') params.set('name', query) // Orca sends "." for "any user"
    let data
    try {
      data = await get(`/users.json?${params}`)
    } catch (e) {
      if (e.status === 403) return { status: 200, body: [] } // listing users needs admin rights
      throw e
    }
    return { status: 200, body: data.users.map(mapUser).filter(Boolean) }
  }
  if (method === 'GET' && (m = /^\/rest\/api\/2\/issue\/createmeta\/([^/]+)\/issuetypes$/.exec(p))) {
    needAuth()
    const id = await resolveProjectId(rm, decodeURIComponent(m[1]), token)
    const { trackers = [] } = (await get(`/projects/${id}.json?include=trackers`)).project
    const values = trackers.map((t) => ({ id: String(t.id), name: t.name, subtask: false }))
    return { status: 200, body: { startAt: 0, maxResults: values.length, total: values.length, isLast: true, values } }
  }
  if (method === 'GET' && /^\/rest\/api\/2\/issue\/createmeta\/[^/]+\/issuetypes\/[^/]+$/.test(p)) {
    needAuth()
    const values = [
      { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } },
      { fieldId: 'description', name: 'Description', required: false, schema: { type: 'string', system: 'description' } }
    ]
    return { status: 200, body: { startAt: 0, maxResults: values.length, total: values.length, isLast: true, values } }
  }
  throw new HttpError(method === 'GET' ? 404 : 405, method === 'GET' ? 'Resource not found' : 'Method not allowed')
}

export function createServer({ redmineUrl = REDMINE_URL } = {}) {
  const rm = newRedmine(redmineUrl)
  return http.createServer(async (req, res) => {
    let out
    try {
      out = await route(rm, req, new URL(req.url, 'http://localhost'))
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      out = { status, body: { errorMessages: e instanceof HttpError ? e.messages : ['Internal error'], errors: {} } }
      if (!(e instanceof HttpError)) console.error('internal error:', e.name) // never log headers
    }
    const json = out.body === undefined ? '' : JSON.stringify(out.body)
    res.writeHead(out.status, { ...(json && { 'Content-Type': 'application/json' }), ...out.headers })
    res.end(json)
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!REDMINE_URL) {
    console.error('Set REDMINE_URL, for example REDMINE_URL=https://redmine.example.com')
    process.exit(1)
  }
  createServer().listen(PORT, HOST, () => console.log(`listening on http://${HOST}:${PORT} -> ${REDMINE_URL}`))
}
