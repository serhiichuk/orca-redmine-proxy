import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { jqlToParams, parseKey, projectKey, mapIssue, mapComments, createServer } from './server.mjs'

const STATUSES = [
  { id: 2, name: 'In Progress' },
  { id: 9, name: 'For Deploy' },
  { id: 8, name: 'In "Review"' }
]

// Copy of buildJiraPresetJql from Orca (shared/jira/jira-preset-jql.ts), without the status normalizer.
function presetJql(filter, statuses = [], currentSprint = false) {
  const clauses = []
  if (filter === 'assigned' || filter === 'done') clauses.push('assignee = currentUser()')
  else if (filter === 'reported') clauses.push('reporter = currentUser()')
  clauses.push(filter === 'done' ? 'statusCategory = Done' : 'statusCategory != Done')
  if (statuses.length) {
    const names = statuses.map((n) => `"${n.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    clauses.push(`status in (${names.join(', ')})`)
  }
  if (currentSprint) clauses.push('sprint in openSprints()')
  return `${clauses.join(' AND ')} ORDER BY updated DESC`
}

const f = (field, op, ...values) => [['f[]', field], [`op[${field}]`, op], ...values.map((v) => [`v[${field}][]`, v])]
const SORT = [['sort', 'updated_on:desc']]

test('preset JQL: every combination of filter x statuses x sprint', () => {
  const who = { assigned: f('assigned_to_id', '=', 'me'), done: f('assigned_to_id', '=', 'me'), reported: f('author_id', '=', 'me'), all: [] }
  for (const filter of ['assigned', 'reported', 'done', 'all']) {
    for (const statuses of [[], ['In Progress', 'In "Review"']]) {
      for (const sprint of [false, true]) {
        const expectedStatus = statuses.length
          ? f('status_id', '=', '2', '8')
          : f('status_id', filter === 'done' ? 'c' : 'o')
        assert.deepEqual(
          jqlToParams(presetJql(filter, statuses, sprint), STATUSES),
          [...who[filter], ...expectedStatus, ...SORT],
          `${filter} statuses=${statuses.length} sprint=${sprint}`
        )
      }
    }
  }
})

test('search-box forms', () => {
  assert.deepEqual(jqlToParams('key = "RM-123"', STATUSES), [...f('issue_id', '=', '123'), ...f('status_id', '*'), ...SORT])
  assert.deepEqual(jqlToParams('text ~ "login bug*"', STATUSES), [...f('status_id', '*'), ...f('subject', '~', 'login bug'), ...SORT])
  assert.deepEqual(jqlToParams('text ~ "a and b"', STATUSES), [...f('status_id', '*'), ...f('subject', '~', 'a and b'), ...SORT])
  assert.deepEqual(jqlToParams('statusCategory != done and text ~ "x*" ORDER BY created ASC'), [
    ...f('status_id', 'o'),
    ...f('subject', '~', 'x'),
    ['sort', 'created_on:asc']
  ])
  assert.deepEqual(jqlToParams('ORDER BY created DESC'), [...f('status_id', '*'), ['sort', 'created_on:desc']])
  assert.deepEqual(jqlToParams('', []), [...f('status_id', '*'), ...SORT])
})

test('unsupported clause throws with status 400', () => {
  assert.throws(() => jqlToParams('project = "X"'), { status: 400 })
  assert.throws(() => jqlToParams('assignee = currentUser() ORDER BY priority'), { status: 400 })
})

test('key parser', () => {
  assert.equal(parseKey('RM-122922'), 122922)
  assert.equal(parseKey('ANY_PREFIX-7'), 7)
  assert.equal(parseKey('nope'), null)
  assert.equal(parseKey('RM-12x'), null)
})

test('project key', () => {
  assert.equal(projectKey('cbx_web'), 'CBX_WEB')
  assert.equal(projectKey('a-b.c'), 'A_B_C')
})

const REDMINE_ISSUE = {
  id: 42,
  project: { id: 62, name: 'Checkbox Web' },
  tracker: { id: 1, name: 'Bug' },
  status: { id: 9, name: 'For Deploy', is_closed: false },
  priority: { id: 3, name: 'High' },
  author: { id: 5, name: 'Ann Author' },
  assigned_to: { id: 6, name: 'Bob Dev' },
  parent: { id: 40 },
  subject: 'Fix it',
  description: 'Details',
  created_on: '2024-01-01T10:00:00Z',
  updated_on: '2024-01-02T10:00:00Z'
}

test('issue mapping', () => {
  const j = mapIssue(REDMINE_ISSUE, { prefix: 'RM', projectKeys: new Map([[62, 'cbx-web']]) })
  assert.deepEqual(j, {
    id: '42',
    key: 'RM-42',
    fields: {
      summary: 'Fix it',
      description: 'Details',
      status: { id: '9', name: 'For Deploy', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
      project: { id: '62', key: 'CBX_WEB', name: 'Checkbox Web' },
      issuetype: { id: '1', name: 'Bug', subtask: true },
      priority: { id: '3', name: 'High' },
      assignee: { name: '6', key: '6', displayName: 'Bob Dev' },
      reporter: { name: '5', key: '5', displayName: 'Ann Author' },
      labels: [],
      created: '2024-01-01T10:00:00Z',
      updated: '2024-01-02T10:00:00Z',
      parent: { id: '40', key: 'RM-40', fields: { summary: '' } }
    }
  })
})

test('issue mapping: closed via cache, null description/assignee, no parent', () => {
  const j = mapIssue(
    { ...REDMINE_ISSUE, status: { id: 5, name: 'Closed' }, description: '', assigned_to: undefined, parent: undefined },
    { closedIds: new Set([5]) }
  )
  assert.equal(j.fields.status.statusCategory.key, 'done')
  assert.equal(j.fields.description, null)
  assert.equal(j.fields.assignee, null)
  assert.equal(j.fields.issuetype.subtask, false)
  assert.equal('parent' in j.fields, false)
  assert.equal(j.fields.project.key, 'P62') // identifier unknown
})

test('comments: only non-empty notes, paged in memory', () => {
  const issue = {
    journals: [
      { id: 1, notes: '', created_on: 'a', user: { id: 5, name: 'Ann' } },
      { id: 2, notes: 'one', created_on: 'b', user: { id: 5, name: 'Ann' } },
      { id: 3, notes: '  ', created_on: 'c', user: { id: 5, name: 'Ann' } },
      { id: 4, notes: 'two', created_on: 'd', updated_on: 'e', user: { id: 6, name: 'Bob' } }
    ]
  }
  const all = mapComments(issue)
  assert.equal(all.total, 2)
  assert.deepEqual(all.comments[1], { id: '4', body: 'two', created: 'd', updated: 'e', author: { name: '6', key: '6', displayName: 'Bob' } })
  assert.equal(all.comments[0].updated, 'b')
  const page = mapComments(issue, 1, 1)
  assert.deepEqual([page.startAt, page.maxResults, page.total, page.comments.map((c) => c.id)], [1, 1, 2, ['4']])
})

// ---------- proxy + stub Redmine (no test ever talks to a real Redmine) ----------

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))

/**
 * Runs a proxy wired to a local stub Redmine. handler(key, body) -> [status, json?] where key is "METHOD /path?query".
 * fn gets call(method, path, body, headers?) -> { status, body } and the list of requests the stub saw.
 */
async function withProxy(handler, fn) {
  const calls = []
  const stub = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : undefined
    calls.push({ method: req.method, path: req.url, body, apiKey: req.headers['x-redmine-api-key'] })
    const [status, data] = handler(`${req.method} ${req.url}`, body) || [404]
    res.writeHead(status, data === undefined ? {} : { 'Content-Type': 'application/json' })
    res.end(data === undefined ? '' : JSON.stringify(data))
  })
  const proxy = createServer({ redmineUrl: await listen(stub) })
  const base = await listen(proxy)
  const call = async (method, path, body, headers = { Authorization: 'Bearer TESTKEY' }) => {
    const res = await fetch(base + '/rest/api/2' + path, {
      method,
      headers: { ...headers, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }
  try {
    await fn(call, calls)
  } finally {
    proxy.close()
    stub.close()
  }
}

const ISSUE_42 = { id: 42, project: { id: 62, name: 'Checkbox Web' }, status: { id: 9, name: 'For Deploy', is_closed: false } }
const reqs = (calls) => calls.map(({ method, path, body }) => (body === undefined ? { method, path } : { method, path, body }))
const ok204 = [204]

test('transitions: allowed statuses without the current one', async () => {
  const h = (k) => k === 'GET /issues/42.json?include=allowed_statuses' && [200, { issue: { ...ISSUE_42, allowed_statuses: [{ id: 2, name: 'In Progress', is_closed: false }, { id: 9, name: 'For Deploy', is_closed: false }, { id: 5, name: 'Done', is_closed: true }] } }]
  await withProxy(h, async (call, calls) => {
    for (const q of ['', '?expand=transitions.fields']) {
      const r = await call('GET', `/issue/RM-42/transitions${q}`)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, {
        transitions: [
          { id: '2', name: 'In Progress', to: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } } },
          { id: '5', name: 'Done', to: { id: '5', name: 'Done', statusCategory: { key: 'done', name: 'Done' } } }
        ]
      })
    }
    assert.equal(calls[0].apiKey, 'TESTKEY') // token pass-through
  })
})

test('transition POST: status_id + notes, fields ignored, 204', async () => {
  await withProxy(() => ok204, async (call, calls) => {
    const r = await call('POST', '/issue/RM-42/transitions', { transition: { id: '5' }, fields: { resolution: { id: '1' } }, update: { comment: [{ add: { body: 'done!' } }] } })
    assert.deepEqual([r.status, r.body], [204, undefined])
    assert.deepEqual(reqs(calls), [{ method: 'PUT', path: '/issues/42.json', body: { issue: { status_id: 5, notes: 'done!' } } }])
    calls.length = 0
    await call('POST', '/issue/RM-42/transitions', { transition: { id: '2' } })
    assert.deepEqual(calls[0].body, { issue: { status_id: 2 } })
    assert.equal((await call('POST', '/issue/RM-42/transitions', { transition: {} })).status, 400)
  })
})

test('issue PUT: summary and priority map to subject and priority_id', async () => {
  await withProxy(() => ok204, async (call, calls) => {
    const r = await call('PUT', '/issue/RM-42', { fields: { summary: 'New title', priority: { id: '5' } } })
    assert.equal(r.status, 204)
    await call('PUT', '/issue/RM-42', { fields: { priority: null } })
    assert.deepEqual(reqs(calls), [
      { method: 'PUT', path: '/issues/42.json', body: { issue: { subject: 'New title', priority_id: 5 } } },
      { method: 'PUT', path: '/issues/42.json', body: { issue: { priority_id: '' } } }
    ])
  })
})

test('issue PUT: labels are rejected with 400 and nothing reaches Redmine', async () => {
  await withProxy(() => ok204, async (call, calls) => {
    for (const body of [{ fields: { labels: ['a'] } }, { fields: {}, update: { labels: [{ add: 'a' }] } }]) {
      const r = await call('PUT', '/issue/RM-42', body)
      assert.deepEqual([r.status, r.body], [400, { errorMessages: ['Redmine has no labels'], errors: {} }])
    }
    assert.equal(calls.length, 0)
  })
})

test('assignee: id is sent as number, null unassigns with ""', async () => {
  await withProxy(() => ok204, async (call, calls) => {
    assert.equal((await call('PUT', '/issue/RM-42/assignee', { name: '6' })).status, 204)
    assert.equal((await call('PUT', '/issue/RM-42/assignee', { name: null })).status, 204)
    assert.equal((await call('PUT', '/issue/RM-42/assignee', { name: 'bob' })).status, 400)
    assert.equal((await call('PUT', '/issue/RM-42/assignee', {})).status, 400)
    assert.deepEqual(reqs(calls), [
      { method: 'PUT', path: '/issues/42.json', body: { issue: { assigned_to_id: 6 } } },
      { method: 'PUT', path: '/issues/42.json', body: { issue: { assigned_to_id: '' } } }
    ])
  })
})

test('comment POST: PUT notes, read journals back, 201 with the newest note', async () => {
  const journals = [
    { id: 1, notes: 'old', created_on: 'a', user: { id: 5, name: 'Ann' } },
    { id: 7, notes: 'hello', created_on: 'b', user: { id: 6, name: 'Bob' } }
  ]
  const h = (k) => (k === 'PUT /issues/42.json' ? ok204 : k === 'GET /issues/42.json?include=journals' && [200, { issue: { id: 42, journals } }])
  await withProxy(h, async (call, calls) => {
    const r = await call('POST', '/issue/RM-42/comment', { body: 'hello' })
    assert.deepEqual([r.status, r.body], [201, { id: '7', body: 'hello', created: 'b', updated: 'b', author: { name: '6', key: '6', displayName: 'Bob' } }])
    assert.deepEqual(reqs(calls), [
      { method: 'PUT', path: '/issues/42.json', body: { issue: { notes: 'hello' } } },
      { method: 'GET', path: '/issues/42.json?include=journals' }
    ])
    assert.equal((await call('POST', '/issue/RM-42/comment', { body: ' ' })).status, 400)
  })
})

test('create issue: POST /issues.json, other fields ignored, 201', async () => {
  const h = (k) => k === 'POST /issues.json' && [201, { issue: { id: 77 } }]
  await withProxy(h, async (call, calls) => {
    const fields = { project: { id: '62' }, issuetype: { id: '5' }, summary: 'Hi', description: 'Body', customfield_1: 'x', priority: { id: '3' } }
    const r = await call('POST', '/issue', { fields })
    assert.equal(r.status, 201)
    assert.deepEqual([r.body.id, r.body.key], ['77', 'RM-77'])
    assert.match(r.body.self, /\/issues\/77$/)
    assert.deepEqual(reqs(calls), [{ method: 'POST', path: '/issues.json', body: { issue: { project_id: 62, tracker_id: 5, subject: 'Hi', description: 'Body' } } }])
    assert.equal((await call('POST', '/issue', { fields: { project: { id: '62' } } })).status, 400)
  })
})

test('Redmine 422 {errors} becomes 400 {errorMessages, errors: {}}', async () => {
  const h = () => [422, { errors: ['Subject cannot be blank', 'Priority is invalid'] }]
  await withProxy(h, async (call) => {
    for (const r of [
      await call('PUT', '/issue/RM-42', { fields: { summary: '' } }),
      await call('POST', '/issue', { fields: { project: { id: '1' }, issuetype: { id: '1' }, summary: 'x' } })
    ]) {
      assert.deepEqual([r.status, r.body], [400, { errorMessages: ['Subject cannot be blank', 'Priority is invalid'], errors: {} }])
    }
  })
})

test('priority list: active only, ids are strings', async () => {
  const h = (k) => k === 'GET /enumerations/issue_priorities.json' && [200, { issue_priorities: [{ id: 1, name: 'Low', active: true }, { id: 3, name: 'Old', active: false }, { id: 5, name: 'High' }] }]
  await withProxy(h, async (call) => {
    assert.deepEqual((await call('GET', '/priority')).body, [{ id: '1', name: 'Low' }, { id: '5', name: 'High' }])
  })
})

test('project list: paginates, key matches the read path', async () => {
  const all = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, identifier: i === 61 ? 'cbx-web' : `p${i + 1}`, name: `Project ${i + 1}` }))
  const h = (k) => {
    const m = /^GET \/projects\.json\?limit=100&offset=(\d+)$/.exec(k)
    return m && [200, { projects: all.slice(Number(m[1]), Number(m[1]) + 100), total_count: 150, offset: Number(m[1]), limit: 100 }]
  }
  await withProxy(h, async (call, calls) => {
    const r = await call('GET', '/project')
    assert.equal(r.body.length, 150)
    assert.deepEqual(r.body[61], { id: '62', key: projectKey('cbx-web'), name: 'Project 62' })
    assert.deepEqual(calls.map((c) => c.path), ['/projects.json?limit=100&offset=0', '/projects.json?limit=100&offset=100'])
  })
})

test('read path reuses the project cache filled by GET /project', async () => {
  const h = (k) =>
    k === 'GET /projects.json?limit=100&offset=0' ? [200, { projects: [{ id: 62, identifier: 'cbx-web', name: 'Checkbox Web' }], total_count: 1 }]
    : k === 'GET /issue_statuses.json' ? [200, { issue_statuses: [] }]
    : k === 'GET /issues/42.json' && [200, { issue: ISSUE_42 }]
  await withProxy(h, async (call, calls) => {
    await call('GET', '/project')
    const r = await call('GET', '/issue/RM-42')
    assert.equal(r.body.fields.project.key, 'CBX_WEB')
    assert.equal(calls.some((c) => c.path === '/projects/62.json'), false)
  })
})

const MEMBERSHIPS = {
  memberships: [
    { id: 1, project: { id: 62 }, user: { id: 91, name: 'Alice Example' } },
    { id: 2, project: { id: 62 }, group: { id: 3, name: 'Devs' } },
    { id: 3, project: { id: 62 }, user: { id: 83, name: 'Bob Example' } }
  ],
  total_count: 3
}

test('assignable users: by issue and by project key, name filter ignores case, groups skipped', async () => {
  const h = (k) =>
    k === 'GET /issues/42.json' ? [200, { issue: ISSUE_42 }]
    : k === 'GET /projects.json?limit=100&offset=0' ? [200, { projects: [{ id: 62, identifier: 'cbx-web', name: 'W' }], total_count: 1 }]
    : k === 'GET /projects/62/memberships.json?limit=100&offset=0' && [200, MEMBERSHIPS]
  await withProxy(h, async (call, calls) => {
    const both = [{ name: '91', key: '91', displayName: 'Alice Example' }, { name: '83', key: '83', displayName: 'Bob Example' }]
    assert.deepEqual((await call('GET', '/user/assignable/search?issueKey=RM-42&maxResults=50')).body, both)
    assert.deepEqual((await call('GET', '/user/assignable/search?project=CBX_WEB&username=BOB')).body, [both[1]])
    assert.deepEqual((await call('GET', '/user/assignable/search?project=62&query=zzz')).body, [])
    assert.equal((await call('GET', '/user/assignable/search')).status, 400)
    assert.equal(calls.every((c) => c.method === 'GET'), true)
  })
})

test('user search: 403 from Redmine gives [], "." means any user', async () => {
  await withProxy(() => [403], async (call) => {
    assert.deepEqual((await call('GET', '/user/search?username=a')).body, [])
  })
  const h = (k) => k === 'GET /users.json?limit=50' && [200, { users: [{ id: 1, firstname: 'Ann', lastname: 'Author' }] }]
  await withProxy(h, async (call) => {
    assert.deepEqual((await call('GET', '/user/search?username=.&maxResults=50')).body, [{ name: '1', key: '1', displayName: 'Ann Author' }])
  })
})

test('createmeta: issue types from trackers, minimal field list', async () => {
  const h = (k) =>
    k === 'GET /projects.json?limit=100&offset=0' ? [200, { projects: [{ id: 62, identifier: 'cbx-web', name: 'W' }], total_count: 1 }]
    : k === 'GET /projects/62.json?include=trackers' && [200, { project: { id: 62, trackers: [{ id: 5, name: 'Task' }, { id: 1, name: 'Error' }] } }]
  await withProxy(h, async (call) => {
    for (const ref of ['CBX_WEB', '62']) {
      const r = await call('GET', `/issue/createmeta/${ref}/issuetypes`)
      assert.deepEqual(r.body.values, [{ id: '5', name: 'Task', subtask: false }, { id: '1', name: 'Error', subtask: false }])
      assert.equal(r.body.isLast, true)
    }
    const f = await call('GET', '/issue/createmeta/CBX_WEB/issuetypes/5')
    assert.deepEqual(f.body.values.map((x) => [x.fieldId, x.required]), [['summary', true], ['description', false]])
    assert.equal((await call('GET', '/issue/createmeta/NOPE/issuetypes')).status, 404)
  })
})

test('unknown paths, missing auth', async () => {
  await withProxy(() => ok204, async (call, calls) => {
    assert.equal((await call('POST', '/nope', {})).status, 405)
    assert.equal((await call('GET', '/nope')).status, 404)
    assert.equal((await call('PUT', '/issue/RM-42', { fields: {} }, {})).status, 401)
    assert.equal((await call('POST', '/issue/RM-42/comment', { body: 'x' }, {})).status, 401)
    assert.equal(calls.length, 0)
  })
})
