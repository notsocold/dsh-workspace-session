/**
 * dsh-workspace-session browser half: Settings → Workspace Sessions.
 *
 * Build-free lazy CommonJS; the only require is React. Data comes exclusively
 * from the authenticated same-origin routes in lib/api.js.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-workspace-session',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-workspace-session'
    const API_STATE = '/api/dsh-workspace-session/state'
    const API_ACTION = '/api/dsh-workspace-session/action'
    const SETTINGS_ORDER = 40

    const runtime = { translate: null, refreshSessions: null }

    const en = {
      nav: 'Workspace Sessions',
      'page.title': 'Workspace Sessions',
      'page.intro': 'Sessions that belong to a workspace are mirrored into <workspace>/.dsh/sessions as text snapshots for git, and imported back into the native store on this machine. Native sessions that belong to no workspace stay untouched.',
      'common.loading': 'Loading…',
      'common.refresh': 'Refresh',
      'common.working': 'Working…',
      'common.never': 'never',
      'common.unknown': 'unknown',
      'common.failed': 'The request failed: {message}',
      'status.machine': 'Machine {machine}',
      'status.lastSweep': 'Last sweep {time}',
      'status.pending': '{count} pending export(s)',
      'status.enabled': 'Sync enabled',
      'status.disabled': 'Sync disabled',
      'actions.title': 'Actions',
      'actions.sync': 'Sync now',
      'actions.import': 'Import from workspace',
      'actions.export': 'Export to workspace',
      'actions.busy': 'Working…',
      'actions.done': 'Done: {message}',
      'settings.title': 'Automatic sync',
      'settings.autoExport': 'Export after each turn',
      'settings.exportOnDispose': 'Export when a session closes',
      'settings.autoImportOnStart': 'Import on startup',
      'settings.autoImportOnWorkspaceAdd': 'Import when a workspace is added',
      'settings.importPollMs': 'Poll interval (ms, 0 disables)',
      'settings.conflictPolicy': 'Conflict policy',
      'settings.save': 'Save settings',
      'settings.saved': 'Settings saved.',
      'settings.enabled': 'Enable workspace sync',
      'conflict.keep-both': 'Keep both (remote branch as a new session)',
      'conflict.local-wins': 'Keep local (backup remote)',
      'conflict.remote-wins': 'Keep remote (backup local)',
      'workspaces.title': 'Workspaces',
      'workspaces.empty': 'No workspaces registered yet. Add a workspace from the sidebar first.',
      'workspaces.path': 'Path',
      'workspaces.snapshots': 'Snapshots',
      'workspaces.imported': 'Imported sessions',
      'workspaces.members': 'Workspace sessions',
      'workspaces.lastScan': 'Last scan',
      'conflicts.title': 'Recent conflicts',
      'conflicts.empty': 'No conflicts recorded.',
      'conflicts.session': 'Session {id}',
      'conflicts.backup': 'Backup: {path}',
    }

    const zh = {
      nav: '工作区会话',
      'page.title': '工作区会话',
      'page.intro': '属于某个工作区的会话会被镜像到 <workspace>/.dsh/sessions（纯文本，随 git 提交），并在本机导入回原生存储。不属于任何工作区的原生会话保持不变。',
      'common.loading': '加载中…',
      'common.refresh': '刷新',
      'common.working': '处理中…',
      'common.never': '从未',
      'common.unknown': '未知',
      'common.failed': '请求失败：{message}',
      'status.machine': '机器 {machine}',
      'status.lastSweep': '上次同步 {time}',
      'status.pending': '{count} 个待导出',
      'status.enabled': '同步已启用',
      'status.disabled': '同步已禁用',
      'actions.title': '操作',
      'actions.sync': '立即同步',
      'actions.import': '从工作区导入',
      'actions.export': '导出到工作区',
      'actions.busy': '处理中…',
      'actions.done': '完成：{message}',
      'settings.title': '自动同步',
      'settings.autoExport': '每轮对话结束后导出',
      'settings.exportOnDispose': '会话关闭时导出',
      'settings.autoImportOnStart': '启动时导入',
      'settings.autoImportOnWorkspaceAdd': '添加工作区时导入',
      'settings.importPollMs': '轮询间隔（毫秒，0 表示关闭）',
      'settings.conflictPolicy': '冲突策略',
      'settings.save': '保存设置',
      'settings.saved': '设置已保存。',
      'settings.enabled': '启用工作区会话同步',
      'conflict.keep-both': '保留两份（远端分支另存新会话）',
      'conflict.local-wins': '保留本机（备份远端）',
      'conflict.remote-wins': '保留远端（备份本机）',
      'workspaces.title': '工作区',
      'workspaces.empty': '还没有工作区。请先在侧边栏添加一个工作区。',
      'workspaces.path': '路径',
      'workspaces.snapshots': '快照数',
      'workspaces.imported': '已导入会话',
      'workspaces.members': '工作区会话',
      'workspaces.lastScan': '上次扫描',
      'conflicts.title': '最近冲突',
      'conflicts.empty': '没有冲突记录。',
      'conflicts.session': '会话 {id}',
      'conflicts.backup': '备份：{path}',
    }

    /**
     * @param {string} text - template.
     * @param {Record<string, unknown>} [params] - interpolation values.
     * @returns {string} interpolated text.
     */
    function interpolate(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
    }

    /**
     * @param {string} key - dictionary key.
     * @param {Record<string, unknown>} [params] - interpolation values.
     * @returns {string} translated text.
     */
    function translate(key, params) {
      if (runtime.translate !== null) {
        try {
          const text = runtime.translate(key, params)
          if (typeof text === 'string' && text !== '' && text !== key) return text
        } catch {
          // Fall through to the inline English dictionary.
        }
      }
      return interpolate(typeof en[key] === 'string' ? en[key] : key, params)
    }

    /**
     * @param {Record<string, any>} props - component props.
     * @returns {(key: string, params?: Record<string, unknown>) => string} translator.
     */
    function translateOf(props) {
      return props !== null && props !== undefined && typeof props.t === 'function' ? props.t : translate
    }

    /**
     * @param {unknown} cause - failure value.
     * @param {(key: string, params?: Record<string, unknown>) => string} t - translator.
     * @returns {string} failure text.
     */
    function failureText(cause, t) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return t('common.failed', { message })
    }

    /**
     * @param {string} key - dictionary key.
     * @param {Record<string, unknown>} [params] - interpolation values.
     * @returns {Promise<any>} parsed response value.
     */
    async function requestJson(key, params) {
      const response = await fetch(key, params)
      const payload = await response.json().catch(() => null)
      if (payload === null || typeof payload !== 'object') {
        throw new Error(`HTTP ${response.status}`)
      }
      if (payload.ok !== true) {
        const message = typeof payload.error?.message === 'string' ? payload.error.message : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload.value
    }

    /** @returns {Promise<any>} current sync status. */
    function fetchState() {
      return requestJson(API_STATE)
    }

    /**
     * @param {Record<string, unknown>} body - action request.
     * @returns {Promise<any>} action response value.
     */
    function dispatch(body) {
      return requestJson(API_ACTION, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    /* ------------------------------ UI atoms ------------------------------ */

    const styles = {
      section: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0 32px' },
      intro: { margin: 0, opacity: 0.75, lineHeight: 1.55, fontSize: '13px', maxWidth: '760px' },
      card: { border: '1px solid color-mix(in srgb, currentColor 16%, transparent)', borderRadius: '10px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      cardTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      muted: { opacity: 0.65, fontSize: '12px' },
      button: { padding: '6px 12px', borderRadius: '8px', border: '1px solid color-mix(in srgb, currentColor 24%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '13px' },
      buttonPrimary: { padding: '6px 12px', borderRadius: '8px', border: '1px solid transparent', background: 'color-mix(in srgb, currentColor 14%, transparent)', color: 'inherit', cursor: 'pointer', fontSize: '13px', fontWeight: 600 },
      toggleLabel: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
      input: { padding: '5px 8px', borderRadius: '7px', border: '1px solid color-mix(in srgb, currentColor 24%, transparent)', background: 'transparent', color: 'inherit', fontSize: '13px', width: '130px' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' },
      th: { textAlign: 'left', fontWeight: 600, padding: '6px 8px', borderBottom: '1px solid color-mix(in srgb, currentColor 14%, transparent)', opacity: 0.75 },
      td: { padding: '6px 8px', borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)', verticalAlign: 'top' },
      badge: { display: 'inline-block', padding: '1px 8px', borderRadius: '999px', fontSize: '11px', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)' },
      notice: { fontSize: '12.5px', padding: '8px 10px', borderRadius: '8px', border: '1px solid color-mix(in srgb, currentColor 18%, transparent)' },
    }

    /**
     * @param {{ title: string, children?: any }} props - card props.
     * @returns {any} card element.
     */
    function Card(props) {
      return h('section', { style: styles.card },
        h('h3', { style: styles.cardTitle }, props.title),
        props.children)
    }

    /**
     * @param {{ onClick: () => void, primary?: boolean, disabled?: boolean, children: any }} props - button props.
     * @returns {any} button element.
     */
    function Button(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        disabled: props.disabled === true,
        style: props.primary === true ? styles.buttonPrimary : styles.button,
      }, props.children)
    }

    /**
     * @param {{ checked: boolean, onChange: (value: boolean) => void, label: string, disabled?: boolean }} props - toggle props.
     * @returns {any} label element.
     */
    function Toggle(props) {
      return h('label', { style: styles.toggleLabel },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          disabled: props.disabled === true,
          onChange: event => props.onChange(event.target.checked === true),
        }),
        h('span', null, props.label))
    }

    /* --------------------------- Settings section --------------------------- */

    /**
     * @param {Record<string, any>} props - settings section props.
     * @returns {any} settings section.
     */
    function WorkspaceSessionSettings(props) {
      const t = translateOf(props)
      const tRef = useRef(t)
      tRef.current = t
      const [data, setData] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [draft, setDraft] = useState(null)
      const seqRef = useRef(0)

      const load = useCallback(async () => {
        const ticket = ++seqRef.current
        setPhase(previous => (previous === 'ready' ? 'ready' : 'loading'))
        try {
          const value = await fetchState()
          if (ticket !== seqRef.current) return
          setData(value)
          setDraft(prev => prev ?? { ...value.config })
          setPhase('ready')
        } catch (cause) {
          if (ticket !== seqRef.current) return
          setNotice({ kind: 'error', text: failureText(cause, tRef.current) })
          setPhase('error')
        }
      }, [])

      useEffect(() => {
        void load()
        return () => { seqRef.current += 1 }
      }, [load])

      useEffect(() => {
        if (notice === null) return undefined
        const timer = window.setTimeout(() => { setNotice(null) }, notice.kind === 'error' ? 9000 : 4500)
        return () => { window.clearTimeout(timer) }
      }, [notice])

      const run = useCallback(async (action, extra) => {
        setBusy(action)
        try {
          const result = await dispatch({ action, ...extra })
          await load()
          // Imported sessions are already attached in the Host workspace
          // ledger; ask the Client session list to pick them up so the
          // sidebar/tree shows them without a page reload.
          if (action === 'sync' || action === 'import') {
            window.setTimeout(() => { runtime.refreshSessions?.() }, 250)
          }
          setNotice({ kind: 'ok', text: tRef.current('actions.done', { message: action }) })
          return result
        } catch (cause) {
          setNotice({ kind: 'error', text: failureText(cause, tRef.current) })
          return null
        } finally {
          setBusy('')
        }
      }, [load])

      const saveConfig = useCallback(async () => {
        if (draft === null) return
        setBusy('config')
        try {
          await dispatch({ action: 'config', patch: draft })
          await load()
          setNotice({ kind: 'ok', text: tRef.current('settings.saved') })
        } catch (cause) {
          setNotice({ kind: 'error', text: failureText(cause, tRef.current) })
        } finally {
          setBusy('')
        }
      }, [draft, load])

      const busyNow = busy !== ''
      const config = draft ?? data?.config ?? {}
      const workspaces = data?.workspaces ?? []
      const conflicts = data?.conflicts ?? []

      const content = useMemo(() => {
        if (phase === 'loading' && data === null) return h('p', { style: styles.muted }, t('common.loading'))
        if (phase === 'error' && data === null) {
          return h(Button, { onClick: () => { void load() } }, t('common.refresh'))
        }
        return [
          h('div', { key: 'status', style: styles.row },
            h('span', { style: styles.badge }, data?.enabled === true ? t('status.enabled') : t('status.disabled')),
            h('span', { style: styles.muted }, t('status.machine', { machine: data?.machineId ?? '?' })),
            h('span', { style: styles.muted }, t('status.lastSweep', { time: data?.lastSweepAt ?? '—' })),
            (data?.pendingExports ?? 0) > 0
              ? h('span', { style: styles.muted }, t('status.pending', { count: data.pendingExports }))
              : null),
          h(Card, { key: 'actions', title: t('actions.title') },
            h('div', { style: styles.row },
              h(Button, { primary: true, disabled: busyNow, onClick: () => { void run('sync') } }, busy === 'sync' ? t('actions.busy') : t('actions.sync')),
              h(Button, { disabled: busyNow, onClick: () => { void run('import', { force: true }) } }, busy === 'import' ? t('actions.busy') : t('actions.import')),
              h(Button, { disabled: busyNow, onClick: () => { void run('export', { force: true }) } }, busy === 'export' ? t('actions.busy') : t('actions.export')),
              h(Button, { disabled: busyNow, onClick: () => { void load() } }, t('common.refresh')))),
          h(Card, { key: 'settings', title: t('settings.title') },
            h(Toggle, {
              checked: config.enabled === true,
              disabled: busyNow,
              label: t('settings.enabled'),
              onChange: value => setDraft({ ...config, enabled: value }),
            }),
            h(Toggle, {
              checked: config.autoExport === true,
              disabled: busyNow,
              label: t('settings.autoExport'),
              onChange: value => setDraft({ ...config, autoExport: value }),
            }),
            h(Toggle, {
              checked: config.exportOnDispose === true,
              disabled: busyNow,
              label: t('settings.exportOnDispose'),
              onChange: value => setDraft({ ...config, exportOnDispose: value }),
            }),
            h(Toggle, {
              checked: config.autoImportOnStart === true,
              disabled: busyNow,
              label: t('settings.autoImportOnStart'),
              onChange: value => setDraft({ ...config, autoImportOnStart: value }),
            }),
            h(Toggle, {
              checked: config.autoImportOnWorkspaceAdd === true,
              disabled: busyNow,
              label: t('settings.autoImportOnWorkspaceAdd'),
              onChange: value => setDraft({ ...config, autoImportOnWorkspaceAdd: value }),
            }),
            h('div', { style: styles.row },
              h('span', { style: styles.toggleLabel }, t('settings.importPollMs')),
              h('input', {
                type: 'number',
                min: 0,
                step: 1000,
                value: Number(config.importPollMs ?? 0),
                disabled: busyNow,
                style: styles.input,
                onChange: event => setDraft({ ...config, importPollMs: Math.max(0, Number(event.target.value) || 0) }),
              })),
            h('div', { style: styles.row },
              h('span', { style: styles.toggleLabel }, t('settings.conflictPolicy')),
              h('select', {
                style: styles.input,
                value: config.conflictPolicy ?? 'keep-both',
                disabled: busyNow,
                onChange: event => setDraft({ ...config, conflictPolicy: event.target.value }),
              },
              ['keep-both', 'local-wins', 'remote-wins'].map(value =>
                h('option', { key: value, value }, t('conflict.' + value))))),
            h('div', { style: styles.row },
              h(Button, { primary: true, disabled: busyNow, onClick: () => { void saveConfig() } }, busy === 'config' ? t('actions.busy') : t('settings.save')))),
          h(Card, { key: 'workspaces', title: t('workspaces.title') },
            workspaces.length === 0
              ? h('p', { style: styles.muted }, t('workspaces.empty'))
              : h('table', { style: styles.table },
                h('thead', null,
                  h('tr', null,
                    h('th', { style: styles.th }, t('workspaces.path')),
                    h('th', { style: styles.th }, t('workspaces.snapshots')),
                    h('th', { style: styles.th }, t('workspaces.imported')),
                    h('th', { style: styles.th }, t('workspaces.members')),
                    h('th', { style: styles.th }, t('workspaces.lastScan')))),
                h('tbody', null, workspaces.map(row =>
                  h('tr', { key: row.path },
                    h('td', { style: styles.td }, h('div', null, row.title), h('div', { style: styles.muted }, row.path)),
                    h('td', { style: styles.td }, String(row.snapshots)),
                    h('td', { style: styles.td }, String(row.importedSessions)),
                    h('td', { style: styles.td }, String(row.sessionIds)),
                    h('td', { style: styles.td }, row.lastScanAt ?? t('common.never'))))))),
          h(Card, { key: 'conflicts', title: t('conflicts.title') },
            conflicts.length === 0
              ? h('p', { style: styles.muted }, t('conflicts.empty'))
              : h('ul', { style: { margin: 0, paddingLeft: '18px', fontSize: '12.5px' } },
                conflicts.map((conflict, index) =>
                  h('li', { key: String(index) },
                    t('conflicts.session', { id: conflict.sessionId ?? '?' }),
                    conflict.backup === undefined ? null : h('div', { style: styles.muted }, t('conflicts.backup', { path: conflict.backup })))))),
        ]
      }, [phase, data, workspaces, conflicts, config, busy, busyNow, t, load, run, saveConfig])

      return h('div', { style: styles.section },
        h('h2', { style: { margin: 0, fontSize: '18px' } }, t('page.title')),
        h('p', { style: styles.intro }, t('page.intro')),
        notice === null ? null : h('div', {
          style: { ...styles.notice, borderColor: notice.kind === 'error' ? 'color-mix(in srgb, #e5484d 45%, transparent)' : undefined },
          role: 'status',
        }, notice.text),
        content)
    }

    /**
     * @param {Record<string, any>} ctx - client root context.
     */
    function apply(ctx) {
      try {
        if (ctx.locale === undefined || ctx.locale === null || typeof ctx.locale.bind !== 'function') {
          throw new Error('locale service is unavailable')
        }
        runtime.translate = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-workspace-session: dictionaries')
      } catch (cause) {
        runtime.translate = null
        try {
          if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('dsh-workspace-session: locale registration failed: ' + String(cause))
        } catch {
          // Logging is best-effort.
        }
      }

      try {
        runtime.refreshSessions = () => {
          try {
            const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
            if (sessions !== undefined && sessions !== null && typeof sessions.refresh === 'function') {
              void sessions.refresh()
            }
          } catch {
            // Refreshing the session list is best-effort.
          }
        }
      } catch {
        runtime.refreshSessions = null
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'workspace-session',
        order: SETTINGS_ORDER,
        label: () => translate('nav'),
        locale: NS,
      }, WorkspaceSessionSettings))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
