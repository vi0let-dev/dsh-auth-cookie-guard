/**
 * dsh-auth-cookie-guard — browser half.
 *
 * Two jobs, intentionally small:
 *   1. On every page boot, ask the Host route to expire stale `dsh-auth-*`
 *      cookies. This is the actual repair: the Host cannot touch Chromium's
 *      cookie jar, but a same-origin response with `Set-Cookie: …; Max-Age=0`
 *      can, and the page's fetch is that response's trigger.
 *   2. Render one Settings section with the current state, a manual purge
 *      button, and the rescue path for the case where the app cannot start at
 *      all (an already oversized Cookie header fails before any page loads).
 *
 * Hand-written ModuleLoader bundle: no build step, no dependencies beyond the
 * React instance the shell already provides, and no network beyond the
 * plugin's own same-origin route.
 */

window.__ModuleLoader__.load({
  id: 'dsh-auth-cookie-guard',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useState } = React

    const NS = 'dshAuthCookieGuard'
    const API = '/api/dsh-auth-cookie-guard'
    const CLIENT_HEADERS = { 'x-dsh-auth-cookie-guard': '1' }
    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        nav: '认证 Cookie 守卫',
        title: '认证 Cookie 守卫',
        subtitle:
          '桌面版每次启动都会换一个随机端口，认证 Cookie 的名字跟着端口变，于是每启动一次就在 127.0.0.1 上多留一枚。累积多了，请求头会撑破上限，启动就直接报 Web authentication failed。本页负责把旧的那几枚清掉。',
        statusTitle: '当前状态',
        origin: '宿主地址',
        currentCookie: '本次认证 Cookie',
        carried: '上次请求携带',
        carriedValue: '{n} 枚认证 Cookie（其中过期 {stale} 枚）',
        headerBytes: '认证 Cookie 请求头',
        headerBytesValue: '{used} / {budget}',
        riskLabel: '风险评估',
        'risk.safe': '正常',
        'risk.warn': '注意',
        'risk.danger': '危险',
        riskHintSafe: '远低于上限，保持自动清理即可。',
        riskHintWarn: '已接近告警阈值，建议立刻清理一次。',
        riskHintDanger: '再启动几次就可能无法打开，请立即清理。',
        lastPurge: '上次清理',
        never: '本次会话尚未清理',
        lastPurgeValue: '{time} · 删除 {n} 枚',
        settingsTitle: '配置',
        settingsHint: '保存后写入当前 profile 的 cordis.patch.yml，立即生效。',
        autoClean: '启动自动清理',
        dryRun: '试运行（只报告不删除）',
        warnAtLabel: '告警阈值',
        warnAtUnit: '枚',
        save: '保存',
        saving: '保存中…',
        saved: '配置已保存。',
        restoreDefaults: '恢复默认',
        restored: '已恢复默认配置。',
        dirty: '有未保存的修改。',
        invalidWarnAt: '告警阈值需要是 1–500 之间的整数。',
        saveFailed: '保存失败：{message}',
        editableOff: '当前 profile 没有提供 configEditor，页面内无法保存；可直接编辑 cordis.patch.yml。',
        on: '开',
        off: '关',
        refresh: '刷新',
        refreshing: '刷新中…',
        purgeNow: '立即清理',
        purging: '清理中…',
        purged: '已删除 {n} 枚过期认证 Cookie，下次启动的请求头会更小。',
        nothing: '没有需要清理的过期 Cookie，当前状态是干净的。',
        unreachable: '连不上插件路由：请确认插件已启用并重启 DSH 后再刷新。',
        loading: '正在读取状态…',
        skippedCurrent:
          '本次请求里没有找到当前端口的认证 Cookie，已跳过删除以免把当前会话踢下线。',
        rescueTitle: '已经打不开桌面版了怎么办',
        rescueBody:
          '如果启动时直接报 Web authentication failed，说明请求头已经超限，页面根本没机会加载。先完全退出桌面版（含托盘与后台进程），再执行仓库里的救援脚本；它只删 dsh-auth-* 行，并先备份数据库。',
        rescueCommand: 'node scripts/purge-auth-cookies.mjs',
        rescuePath: '数据库路径：%APPDATA%\\@deepseek-ai\\dsh-desktop\\Network\\Cookies',
        privacy:
          '只处理本机 127.0.0.1 上由 DSH 自己签发的 dsh-auth-* Cookie；不读取会话内容，不写用户目录，不发起任何外部网络请求。',
        explanation:
          '原理：Chromium 的 Cookie 只按主机隔离，不区分端口；而 Cookie 名里带着 host:port 的哈希。保留当前那枚、过期其余，就等于把以前每次启动留下的记录清掉。',
      },
      en: {
        nav: 'Auth Cookie Guard',
        title: 'Auth Cookie Guard',
        subtitle:
          'The Desktop Host picks a new random loopback port on every launch, and the auth cookie is named after that authority — so each launch leaves one more cookie for 127.0.0.1. Enough of them and the request header exceeds the parser limit, which surfaces as "Web authentication failed". This page clears the old ones.',
        statusTitle: 'Current state',
        origin: 'Host origin',
        currentCookie: 'Cookie for this launch',
        carried: 'Last request carried',
        carriedValue: '{n} auth cookies ({stale} stale)',
        headerBytes: 'Auth cookie header',
        headerBytesValue: '{used} / {budget}',
        riskLabel: 'Risk',
        'risk.safe': 'Healthy',
        'risk.warn': 'Watch',
        'risk.danger': 'Critical',
        riskHintSafe: 'Well below the limit; automatic pruning is enough.',
        riskHintWarn: 'Close to the warning threshold — purging now is a good idea.',
        riskHintDanger: 'A few more launches may fail to open; purge now.',
        lastPurge: 'Last purge',
        never: 'Not purged in this session',
        lastPurgeValue: '{time} · removed {n}',
        settingsTitle: 'Configuration',
        settingsHint: 'Saved into this profile’s cordis.patch.yml and applied immediately.',
        autoClean: 'Prune on boot',
        dryRun: 'Dry run (report only)',
        warnAtLabel: 'Warning threshold',
        warnAtUnit: 'cookies',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Settings saved.',
        restoreDefaults: 'Restore defaults',
        restored: 'Defaults restored.',
        dirty: 'Unsaved changes.',
        invalidWarnAt: 'The threshold must be an integer between 1 and 500.',
        saveFailed: 'Save failed: {message}',
        editableOff: 'This profile provides no configEditor, so the page cannot save; edit cordis.patch.yml instead.',
        on: 'on',
        off: 'off',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        purgeNow: 'Purge now',
        purging: 'Purging…',
        purged: 'Removed {n} stale auth cookies; the next launch sends a smaller header.',
        nothing: 'Nothing stale to remove — the jar is clean.',
        unreachable: 'Cannot reach the plugin route: confirm the plugin is enabled, restart DSH, then refresh.',
        loading: 'Reading state…',
        skippedCurrent:
          'The cookie for the current port was missing from this request, so nothing was deleted to avoid signing the page out.',
        rescueTitle: 'The app no longer starts',
        rescueBody:
          'If startup fails with Web authentication failed, the header is already over the limit and no page can load. Quit the Desktop app completely (tray and background processes included), then run the rescue script from the repository: it removes only dsh-auth-* rows and backs the database up first.',
        rescueCommand: 'node scripts/purge-auth-cookies.mjs',
        rescuePath: 'Database: %APPDATA%\\@deepseek-ai\\dsh-desktop\\Network\\Cookies',
        privacy:
          'Only touches dsh-auth-* cookies issued by DSH itself for 127.0.0.1. No session content is read, nothing is written to user directories, and no external request is made.',
        explanation:
          'Why it works: Chromium scopes cookies by host, not by port, while the cookie name embeds a hash of host:port. Keeping the current one and expiring the rest removes what previous launches left behind.',
      },
    }

    const CSS = `
.dacg-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); }
.dacg-btn { appearance: none; font: inherit; font-size: 13px; font-weight: 600; border-radius: var(--dsw-radius-md); padding: 7px 14px; cursor: pointer; transition: opacity .15s ease; }
.dacg-btn:disabled { opacity: .55; cursor: default; }
.dacg-btn-primary { border: none; background: var(--dsw-alias-brand-primary); color: #fff; }
.dacg-btn-ghost { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); }
.dacg-code { display: block; margin: 6px 0; padding: 8px 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dacg-details summary { cursor: pointer; font-weight: 600; color: var(--dsw-alias-label-primary); }
`

    /**
     * Call the plugin's own route.
     * @param {string} pathname - route suffix, may carry a query string.
     * @param {{ method?: string, body?: string }} [options] - method and body.
     * @returns {Promise<{ ok: boolean, status: number, data: any }>} parsed reply.
     */
    async function request(pathname, options = {}) {
      const hasBody = options.body !== undefined
      const response = await fetch(`${API}${pathname}`, {
        method: options.method ?? 'GET',
        headers: hasBody ? { ...CLIENT_HEADERS, 'content-type': 'application/json' } : { ...CLIENT_HEADERS },
        body: options.body,
        cache: 'no-store',
        credentials: 'same-origin',
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      return { ok: response.ok, status: response.status, data }
    }

    /** Set once per page; a hot reload must not fire another boot request. */
    let bootPurged = false

    /**
     * @param {number} bytes - byte count.
     * @returns {string} human-readable size.
     */
    function formatBytes(bytes) {
      const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
      if (value < 1024) return `${Math.round(value)} B`
      return `${(value / 1024).toFixed(1)} KB`
    }

    /**
     * Replace `{name}` placeholders without depending on locale interpolation.
     * @param {string} template - text with placeholders.
     * @param {Record<string, unknown>} params - values.
     * @returns {string} filled text.
     */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/gu, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
      )
    }

    const RISK_COLOR = {
      safe: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
    }

    /** One labelled control row in the settings card. */
    const CONTROL_ROW = {
      display: 'grid',
      gridTemplateColumns: 'minmax(120px, 168px) 1fr',
      gap: 10,
      padding: '7px 0',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      fontSize: 13,
      alignItems: 'center',
      cursor: 'pointer',
    }

    /** Secondary label inside a control row. */
    const CONTROL_LABEL = { color: 'var(--dsw-alias-label-secondary)' }

    /**
     * One label/value row of the status card.
     * @param {{ label: string, value: unknown, extra?: unknown }} props - row content.
     * @returns {import('react').ReactElement} the row.
     */
    function Row({ label, value, extra }) {
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'minmax(120px, 168px) 1fr',
            gap: 10,
            padding: '7px 0',
            borderTop: '1px solid var(--dsw-alias-border-l1)',
            fontSize: 13,
            alignItems: 'baseline',
          },
        },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
        h(
          'span',
          { style: { color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' } },
          value,
          extra === undefined ? null : extra,
        ),
      )
    }

    /**
     * The Settings section.
     * @param {{ t: (key: string) => string }} props - slot props plus the bound translator.
     * @returns {import('react').ReactElement} the page.
     */
    function GuardPage({ t }) {
      const [snapshot, setSnapshot] = useState(null)
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState('')
      const [savedNote, setSavedNote] = useState('')

      const load = useCallback(async () => {
        setBusy('refresh')
        setError('')
        try {
          const result = await request('/status')
          if (!result.ok || !result.data || result.data.ok !== true) throw new Error('bad status reply')
          setSnapshot(result.data)
        } catch {
          setError(t('unreachable'))
        } finally {
          setBusy(null)
        }
      }, [t])

      const purge = useCallback(async () => {
        setBusy('purge')
        setError('')
        setNote('')
        try {
          const result = await request('/purge?manual=1')
          if (!result.ok || !result.data || result.data.ok !== true) throw new Error('bad purge reply')
          setSnapshot(result.data)
          const deleted = Number(result.data?.purge?.deleted ?? 0)
          setNote(deleted > 0 ? fill(t('purged'), { n: deleted }) : t('nothing'))
        } catch {
          setError(t('unreachable'))
        } finally {
          setBusy(null)
        }
      }, [t])

      const settingsSignature = snapshot?.settings
        ? `${String(snapshot.settings.enabled)}|${String(snapshot.settings.dryRun)}|${String(snapshot.settings.warnAt)}`
        : ''

      // Refill the draft whenever the saved settings change (first load or a
      // successful save), without clobbering edits while the user types.
      useEffect(() => {
        if (!snapshot?.settings) return
        setDraft({
          enabled: snapshot.settings.enabled === true,
          dryRun: snapshot.settings.dryRun === true,
          warnAt: String(snapshot.settings.warnAt),
        })
      }, [settingsSignature])

      const dirty =
        draft !== null &&
        snapshot?.settings !== undefined &&
        (draft.enabled !== (snapshot.settings.enabled === true) ||
          draft.dryRun !== (snapshot.settings.dryRun === true) ||
          draft.warnAt !== String(snapshot.settings.warnAt))

      const persist = useCallback(async (nextDraft, noteKey) => {
        const warnAt = Number.parseInt(nextDraft.warnAt, 10)
        if (!Number.isInteger(warnAt) || warnAt < 1 || warnAt > 500) {
          setSaveError(t('invalidWarnAt'))
          return
        }
        setSaving(true)
        setSaveError('')
        setSavedNote('')
        try {
          const result = await request('/settings', {
            method: 'POST',
            body: JSON.stringify({ enabled: nextDraft.enabled, dryRun: nextDraft.dryRun, warnAt }),
          })
          if (!result.ok || !result.data || result.data.ok !== true) {
            throw new Error(result.data?.message ?? `HTTP ${String(result.status)}`)
          }
          setSavedNote(t(noteKey))
          // The save reloads this plugin row, so re-reading /status right away
          // could race the route being registered again; use the reply instead.
          setSnapshot((previous) =>
            previous === null
              ? previous
              : {
                  ...previous,
                  settings: result.data.settings,
                  editable: result.data.editable === true,
                },
          )
        } catch (caught) {
          setSaveError(
            fill(t('saveFailed'), { message: caught instanceof Error ? caught.message : String(caught) }),
          )
        } finally {
          setSaving(false)
        }
      }, [t])

      const save = useCallback(() => persist(draft, 'saved'), [draft, persist])

      const restoreDefaults = useCallback(() => {
        const defaults = snapshot?.defaults
        if (!defaults) return
        const next = {
          enabled: defaults.enabled === true,
          dryRun: defaults.dryRun === true,
          warnAt: String(defaults.warnAt),
        }
        setDraft(next)
        return persist(next, 'restored')
      }, [persist, snapshot])

      useEffect(() => {
        load()
      }, [load])

      const risk = snapshot?.risk ?? 'safe'
      const riskColor = RISK_COLOR[risk] ?? RISK_COLOR.safe
      const budget = Number(snapshot?.budgetBytes ?? 16384)
      const used = Number(snapshot?.headerBytes ?? 0)
      const percent = Math.max(0, Math.min(100, Math.round((used / budget) * 100)))

      const statusRows = useMemo(() => {
        if (!snapshot) return []
        const last = snapshot.last
        return [
          ['origin', snapshot.origin ?? '—', null],
          ['currentCookie', snapshot.currentNameShort ?? '—', null],
          [
            'carried',
            fill(t('carriedValue'), { n: snapshot.carried ?? 0, stale: snapshot.stale ?? 0 }),
            null,
          ],
          [
            'headerBytes',
            fill(t('headerBytesValue'), { used: formatBytes(used), budget: formatBytes(budget) }),
            null,
          ],
          [
            'lastPurge',
            last ? fill(t('lastPurgeValue'), { time: new Date(last.at).toLocaleTimeString(), n: last.purged }) : t('never'),
            null,
          ],
        ]
      }, [snapshot, t, used, budget])

      const hintKey = `riskHint${risk.charAt(0).toUpperCase()}${risk.slice(1)}`

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760, padding: '4px 0 24px' } },
        h('div', null,
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('title')),
          h('p', { style: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)' } }, t('subtitle')),
        ),

        h('div', { className: 'dacg-card', style: { padding: 14 } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            h('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('statusTitle')),
            h('span', {
              style: {
                fontSize: 12,
                fontWeight: 700,
                color: riskColor,
                border: `1px solid ${riskColor}`,
                borderRadius: 999,
                padding: '2px 10px',
              },
            }, t(`risk.${risk}`)),
          ),

          !snapshot
            ? h('p', { style: { margin: '10px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('loading'))
            : h('div', { style: { marginTop: 6 } },
                statusRows.map(([labelKey, value]) => h(Row, { key: labelKey, label: t(labelKey), value })),
                h('div', { style: { marginTop: 10 } },
                  h('div', {
                    style: {
                      height: 6,
                      borderRadius: 999,
                      background: 'var(--dsw-alias-bg-layer-2)',
                      overflow: 'hidden',
                    },
                  },
                    h('div', {
                      style: { width: `${percent}%`, height: '100%', background: riskColor, transition: 'width .2s ease' },
                    }),
                  ),
                  h('p', { style: { margin: '6px 0 0', fontSize: 12, color: riskColor } }, t(hintKey)),
                  snapshot.skipped === 'current-cookie-missing'
                    ? h('p', { style: { margin: '4px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, t('skippedCurrent'))
                    : null,
                ),
              ),

          error !== ''
            ? h('p', { style: { margin: '10px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error)
            : null,
          note !== ''
            ? h('p', { style: { margin: '10px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' } }, note)
            : null,

          h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              className: 'dacg-btn dacg-btn-primary',
              onClick: purge,
              disabled: busy !== null,
            }, busy === 'purge' ? t('purging') : t('purgeNow')),
            h('button', {
              type: 'button',
              className: 'dacg-btn dacg-btn-ghost',
              onClick: load,
              disabled: busy !== null,
            }, busy === 'refresh' ? t('refreshing') : t('refresh')),
          ),
        ),

        snapshot && draft
          ? h('div', { className: 'dacg-card', style: { padding: 14 } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } },
                h('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('settingsTitle')),
                dirty
                  ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' } }, t('dirty'))
                  : null,
              ),
              h('p', { style: { margin: '4px 0 10px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('settingsHint')),

              h('label', { style: CONTROL_ROW },
                h('span', { style: CONTROL_LABEL }, t('autoClean')),
                h('input', {
                  type: 'checkbox',
                  checked: draft.enabled === true,
                  disabled: saving || snapshot.editable !== true,
                  onChange: (event) => setDraft({ ...draft, enabled: event.target.checked }),
                }),
              ),
              h('label', { style: CONTROL_ROW },
                h('span', { style: CONTROL_LABEL }, t('dryRun')),
                h('input', {
                  type: 'checkbox',
                  checked: draft.dryRun === true,
                  disabled: saving || snapshot.editable !== true,
                  onChange: (event) => setDraft({ ...draft, dryRun: event.target.checked }),
                }),
              ),
              h('label', { style: CONTROL_ROW },
                h('span', { style: CONTROL_LABEL }, t('warnAtLabel')),
                h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                  h('input', {
                    type: 'number',
                    min: 1,
                    max: 500,
                    value: draft.warnAt,
                    disabled: saving || snapshot.editable !== true,
                    onChange: (event) => setDraft({ ...draft, warnAt: event.target.value }),
                    style: {
                      width: 92,
                      padding: '4px 8px',
                      fontSize: 13,
                      borderRadius: 'var(--dsw-radius-md)',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      background: 'var(--dsw-alias-bg-base)',
                      color: 'var(--dsw-alias-label-primary)',
                    },
                  }),
                  h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('warnAtUnit')),
                ),
              ),

              snapshot.editable !== true
                ? h('p', { style: { margin: '6px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, t('editableOff'))
                : null,

              h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
                h('button', {
                  type: 'button',
                  className: 'dacg-btn dacg-btn-primary',
                  onClick: save,
                  disabled: saving || dirty !== true || snapshot.editable !== true,
                }, saving ? t('saving') : t('save')),
                h('button', {
                  type: 'button',
                  className: 'dacg-btn dacg-btn-ghost',
                  onClick: restoreDefaults,
                  disabled: saving || snapshot.editable !== true,
                }, t('restoreDefaults')),
              ),

              savedNote !== ''
                ? h('p', { style: { margin: '10px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' } }, savedNote)
                : null,
              saveError !== ''
                ? h('p', { style: { margin: '10px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, saveError)
                : null,
            )
          : null,

        h('details', { className: 'dacg-card dacg-details', style: { padding: 14 } },
          h('summary', null, t('rescueTitle')),
          h('p', { style: { fontSize: 13, lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)' } }, t('rescueBody')),
          h('code', { className: 'dacg-code' }, t('rescueCommand')),
          h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('rescuePath')),
        ),

        h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } }, t('explanation')),
        h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } }, t('privacy')),
      )
    }

    return {
      inject,
      apply(ctx) {
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-auth-cookie-guard: dictionaries')

        ctx.effect(() => {
          if (typeof document === 'undefined' || !document.head) return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-auth-cookie-guard')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-auth-cookie-guard: styles')

        // The repair itself: one same-origin GET after every boot. Failure is
        // silent by design — a missing route must never break the page.
        ctx.effect(() => {
          if (!bootPurged) {
            bootPurged = true
            request('/purge').catch(() => {})
          }
          return () => {}
        }, 'dsh-auth-cookie-guard: boot purge')

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-auth-cookie-guard',
              order: 42,
              label: () => t('nav'),
              locale: NS,
            },
            (props) => h(GuardPage, { ...props, t }),
          ),
        )
      },
    }
  },
})
