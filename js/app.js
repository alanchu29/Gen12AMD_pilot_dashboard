/* App shell: wires Store to the portfolio list, detail view (KPIs, Gantt, table), dialogs and cloud sync. */
(function () {
  const E = window.Engine;
  const $ = U.$;

  // ---------------------------------------------------------------- tooltip & toast
  const tipEl = () => $("#tooltip");
  const tip = {
    show(html, ev) {
      const t = tipEl();
      if (!html) return tip.hide();
      if (t._html !== html) {
        t.innerHTML = html;
        t._html = html;
      }
      t.hidden = false;
      const pad = 14;
      const w = t.offsetWidth;
      const h = t.offsetHeight;
      let x = ev.clientX + pad;
      let y = ev.clientY + pad;
      if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
      if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
      t.style.left = Math.max(8, x) + "px";
      t.style.top = Math.max(8, y) + "px";
    },
    hide() {
      tipEl().hidden = true;
    },
  };

  function toast(msg, kind, actions) {
    const box = $("#toasts");
    const n = document.createElement("div");
    n.className = "toast " + (kind || "");
    n.setAttribute("role", kind === "error" ? "alert" : "status");
    n.innerHTML = `<span>${U.esc(msg)}</span>`;
    for (const a of actions || []) {
      const b = document.createElement("button");
      b.textContent = a.label;
      b.onclick = () => {
        n.remove();
        a.run();
      };
      n.appendChild(b);
    }
    const close = document.createElement("button");
    close.className = "x";
    close.setAttribute("aria-label", "關閉");
    close.textContent = "✕";
    close.onclick = () => n.remove();
    n.appendChild(close);
    box.appendChild(n);
    if (!actions || !actions.length) setTimeout(() => n.remove(), kind === "error" ? 6000 : 3000);
  }

  // ---------------------------------------------------------------- render scheduling
  const pending = new Set();
  let raf = 0;
  function renderSoon(...parts) {
    (parts.length ? parts : ["list", "detail", "load", "status"]).forEach((p) => pending.add(p));
    if (!raf) raf = requestAnimationFrame(flush);
  }
  // Only the visible page renders; switching pages re-renders everything ("page").
  function flush() {
    raf = 0;
    const parts = new Set(pending);
    pending.clear();
    if (parts.has("page")) applyPage();
    if (Store.ui.page === "load") {
      if (parts.has("load")) Load.render();
    } else {
      if (parts.has("filters")) Portfolio.renderFilters($("#pfFilters"));
      if (parts.has("list")) Portfolio.render($("#pfList"));
      if (parts.has("detail")) renderDetail();
    }
    if (parts.has("status")) renderStatus();
  }

  function applyPage() {
    const load = Store.ui.page === "load";
    $("#portfolio").hidden = load;
    $("#load").hidden = !load;
    if (load) $("#detail").hidden = true;
    document.querySelectorAll("[data-page]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.page === Store.ui.page)));
  }

  // ---------------------------------------------------------------- theme
  function applyTheme() {
    const t = Store.ui.theme;
    if (t === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const b = $("#btnTheme");
    b.textContent = t === "dark" ? "☾" : t === "light" ? "☀" : "◐";
    b.title = `主題：${t === "auto" ? "跟隨系統" : t === "dark" ? "深色" : "淺色"}（點擊切換）`;
  }

  // ---------------------------------------------------------------- status bar
  // loaded: the cloud copy has been read at least once this session (until then, the page shows the local fallback)
  const sync = { state: "local", at: null, msg: "", loaded: false };
  function renderStatus() {
    const chip = $("#syncChip");
    const offline = sync.state === "error" && !sync.loaded;
    const labels = {
      local: "本機模式",
      syncing: "同步中…",
      synced: "雲端已同步" + (sync.at ? " · " + sync.at.toTimeString().slice(0, 5) : ""),
      error: offline ? "離線 · 本機備份" : "同步失敗 · 稍後重試",
      conflict: "雲端版本衝突",
    };
    chip.textContent = labels[sync.state];
    chip.className = "sync-chip " + sync.state;
    chip.title =
      (offline ? "無法連線雲端，目前顯示此瀏覽器上次保存的資料（可能不是最新）。\n" : "") +
      (sync.msg || (sync.state === "local" ? "資料存在此瀏覽器（localStorage）。點擊設定 Google Sheet 雲端同步。" : ""));
    const ch = Remote.active ? localChanges() : null;
    const pending = !!(ch && ch.count);
    if (pending && sync.state === "synced") {
      chip.textContent = "本機修改 · 未同步";
      chip.className = "sync-chip dirty";
      chip.title = "目前顯示的是這個瀏覽器的修改版本，其他人看不到。按「同步到雲端」上傳。";
    }
    $("#btnSync").hidden = !pending;
    $("#localBanner").hidden = !pending;
    if (pending) $("#localBannerMsg").textContent = `目前顯示為本機修改版本：${describeChanges(ch)}，只存在這個瀏覽器，其他人看不到。`;
    hadChanges = pending;
    if (Store.saveError) {
      chip.textContent = "⚠ 本機儲存失敗";
      chip.className = "sync-chip error";
      chip.title = "瀏覽器儲存空間不足或被封鎖，請匯出 JSON 備份。";
    }
    $("#btnUndo").disabled = !Store.undoStack.length;
    $("#btnRedo").disabled = !Store.redoStack.length;
    const src = Store.data.source || {};
    $("#sourceLine").textContent = src.file ? `資料來源：${src.file}` : "";
    $("#sourceLine").title = src.importedAt ? `匯入時間 ${src.importedAt}` : "";
  }

  // ---------------------------------------------------------------- detail view
  function kpi(label, value, sub, cls) {
    return `<div class="kpi ${cls || ""}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  }

  function legendHtml(pfam) {
    if (Store.ui.colorBy === "section") {
      return pfam.tasks
        .filter((t) => t.type === "section")
        .map((t, i) => `<span><i class="sw s${(i % 8) + 1}"></i>${U.esc(t.name.length > 28 ? t.name.slice(0, 28) + "…" : t.name)}</span>`)
        .join("");
    }
    const used = new Set(pfam.tasks.filter((t) => t.type === "task").map((t) => U.ownerGroup(t.lead)));
    return U.OWNER_GROUPS.filter((g) => used.has(g.key)).map((g) => `<span><i class="sw s${g.slot}"></i>${g.label}</span>`).join("");
  }

  /**
   * What the detail panel shows: a single sheet, or a merged group (1st + 2nd builds).
   * `pfam` is always the sheet that edits go to (in a group: the active raw-table tab).
   */
  function view() {
    const id = Store.ui.selectedId;
    if (!id) return null;
    if (id.startsWith("g:")) {
      const g = Groups.find(id);
      if (!g) return null;
      let tab = Store.ui.tableTab[id];
      if (!g.members.some((m) => m.p.id === tab)) tab = g.members[0].p.id;
      return { mode: "group", id, g, merged: Groups.merged(g), pfam: Store.pfam(tab) };
    }
    const p = Store.pfam(id);
    return p ? { mode: "pfam", id, pfam: p } : null;
  }

  function editPfam() {
    const v = view();
    return v ? v.pfam : null;
  }

  function isShowing(pfamId) {
    const v = view();
    return !!v && (v.pfam.id === pfamId || (v.mode === "group" && v.g.members.some((m) => m.p.id === pfamId)));
  }

  function renderDetail() {
    const v = view();
    $("#detail").hidden = !v;
    $("#emptyDetail").hidden = !!v;
    if (!v) return;
    const today = U.today();
    const items = Portfolio.items();
    const idx = items.findIndex((it) => it.id === v.id);
    const roles = Store.ui.focusRoles;
    const roleLabel = roles.length ? roles.join("/") : "高亮角色";
    const until = (d) => (d == null ? "" : d >= today ? `・還有 ${d - today} 天` : "・已過");
    const dockSubOf = (key) =>
      key.dockDelta
        ? `<span class="${key.dockDelta > 0 ? "late" : "early"}">${key.dockDelta > 0 ? "▲ 較基準延後" : "▼ 較基準提前"} ${Math.abs(key.dockDelta)} 天</span>`
        : key.dock ? "與基準相同" : "";

    // What the Gantt draws.
    const gp = v.mode === "group" ? v.merged.pfam : v.pfam;
    const gs = v.mode === "group" ? v.merged.sched : Store.sched(v.pfam);
    const shownTasks = gp.tasks.filter((t) => t.type === "task" && !t._inherited);
    const errors = shownTasks.filter((t) => (gs.rows.get(t.id) || {}).error).length;

    // ---- header
    const nav = `<div class="dh-nav">
        <button class="icon" data-nav="-1" ${idx <= 0 ? "disabled" : ""} title="上一個" aria-label="上一個 PFAM">‹</button>
        <button class="icon" data-nav="1" ${idx < 0 || idx >= items.length - 1 ? "disabled" : ""} title="下一個" aria-label="下一個 PFAM">›</button>
      </div>`;
    const tagChips = (tg, extra) =>
      (tg.gen ? `<span class="tag gen">Gen ${U.esc(tg.gen)}</span>` : "") +
      (tg.site ? `<span class="tag site-${tg.site}">${U.esc(tg.site)}</span>` : "") +
      extra +
      (tg.sku ? `<span class="tag outline">${U.esc(tg.sku)}</span>` : "") +
      (errors ? `<span class="tag err">⚠ ${errors} 個排程錯誤</span>` : "");

    if (v.mode === "group") {
      const pb = v.merged.perBuild;
      const key = { build: pb[0].key.build, etd: pb[0].key.etd, dock: pb[pb.length - 1].key.dock };
      const tg = U.tags(v.g.members[0].p);
      const links = v.g.members
        .map((m) => `<button class="sheet-link" data-open="${m.p.id}" title="只看這個分頁"><span class="build-pill">${U.esc(m.build)}</span>${U.esc(m.p.sheet)}</button>`)
        .join("");
      $("#detailHead").innerHTML = `
        <div class="dh-main">${nav}
          <div class="dh-text">
            <h2>${U.esc(v.g.name)} <span class="merge-note big">1st + 2nd 合併檢視</span></h2>
            <div class="dh-sub">合併 ${v.g.members.length} 個 Excel 分頁：${links}</div>
            <div class="dh-chips">${tagChips(tg, `<span class="tag builds">${v.g.members.map((m) => m.build).join(" + ")}</span>`)}</div>
          </div>
        </div>`;
    } else {
      const p = v.pfam;
      const key = U.keyDates(p, gs);
      const tg = U.tags(p);
      const grp = Groups.groupOfPfam(p.id);
      const meta = [["Lead", p.meta.lead], ["MDM", p.meta.mdm], ["L10 PN", p.meta.l10pn], ["L11 PN", p.meta.l11pn]]
        .filter(([, x]) => x)
        .map(([k, x]) => `<span><b>${k}</b> ${U.esc(x)}</span>`)
        .join("");
      $("#detailHead").innerHTML = `
        <div class="dh-main">${nav}
          <div class="dh-text">
            <h2>${U.esc(p.sheet)}</h2>
            <div class="dh-sub">${U.esc(p.title)}${grp ? ` <button class="sheet-link" data-open="${grp.id}">屬於 ${U.esc(grp.name)} → 看 1st + 2nd 合併</button>` : ""}</div>
            <div class="dh-chips">${tagChips(tg, tg.phase !== "其他" ? `<span class="tag">${U.esc(tg.phase)}</span>` : "")}<span class="tag outline">假日曆 ${U.esc(p.calendar)}</span>${meta ? `<span class="dh-meta">${meta}</span>` : ""}</div>
          </div>
          <div class="dh-actions">
            <button class="btn" id="btnDup" title="複製成新的情境，方便試算不同排程">複製為新情境</button>
            <button class="btn ghost" id="btnDelPfam" title="刪除此 PFAM">刪除</button>
          </div>
        </div>`;
    }

    // ---- KPIs
    const mine = shownTasks.filter((t) => U.matchRoles(t.lead, roles).length);
    const upcoming = mine
      .map((t) => ({ t, r: gs.rows.get(t.id) }))
      .filter((x) => x.r && x.r.end != null && x.r.end >= today)
      .sort((a, b) => a.r.start - b.r.start)[0];
    const focusSub = !roles.length
      ? "在甘特圖工具列設定角色"
      : upcoming
        ? `下一項 ${U.fmt(upcoming.r.start, "md")}${upcoming.t._build ? ` (${U.esc(upcoming.t._build)})` : ""} <span class="kpi-task" title="${U.esc(upcoming.t.name)}">${U.esc(upcoming.t.name)}</span>`
        : mine.length ? "全部已完成" : "沒有相關任務";
    const span = gs.span.start != null ? gs.span.end - gs.span.start + 1 : null;
    const startTile = kpi("專案開始", U.fmt(gs.span.start) || "—", gs.span.start != null ? "週" + "日一二三四五六"[E.weekday(gs.span.start)] + until(gs.span.start) : "", "k-prep");
    const spanTile = kpi("總工期", span ? `${span} 天` : "—", span ? `約 ${(span / 7).toFixed(1)} 週・${shownTasks.length} 個任務` : "", "k-span");
    const focusTile = kpi(`${U.esc(roleLabel)} 任務`, roles.length ? `${mine.length} 項` : "—", focusSub, "k-focus");
    if (v.mode === "group") {
      const buildTiles = v.merged.perBuild
        .map((b) =>
          kpi(
            `${U.esc(b.build)} · L10 Build → Dock`,
            b.key.dock ? U.fmt(b.key.dock.start) : "—",
            `L10 ${b.key.build ? U.fmt(b.key.build.start, "md") : "—"}・ETD ${b.key.etd ? U.fmt(b.key.etd.start, "md") : "—"} ${dockSubOf(b.key)}`,
            "hero k-dock"
          )
        )
        .join("");
      $("#kpis").innerHTML = startTile + buildTiles + spanTile + focusTile;
    } else {
      const key = U.keyDates(v.pfam, gs);
      $("#kpis").innerHTML =
        startTile +
        kpi("L10 Build", key.build ? U.fmt(key.build.start) : "—", key.build ? "量產建置開始" + until(key.build.start) : "", "k-build") +
        kpi("ETD", key.etd ? U.fmt(key.etd.start) : "—", key.etd ? "預計出貨" + until(key.etd.start) : "", "k-ship") +
        kpi("Dock", key.dock ? U.fmt(key.dock.start) : "—", dockSubOf(key), "hero k-dock") +
        spanTile +
        focusTile;
    }

    // ---- local vs cloud
    const cdEntries = (v.mode === "group" ? v.g.members : [{ p: v.pfam }]).map((m) => ({ p: m.p, build: m.build, d: CloudDiff.of(m.p) }));
    const cdOn = Store.ui.showCloudDiff;
    const cdMap = cdOn ? CloudDiff.taskMap(cdEntries, v.mode === "group") : null;
    const cdBox = $("#cloudDiff");
    cdBox.innerHTML = CloudDiff.bannerHtml(cdEntries, cdOn);
    cdBox.hidden = !cdBox.innerHTML;

    // ---- toolbar + legend
    document.querySelectorAll("[data-zoom]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.zoom === Store.ui.zoom)));
    $("#colorBy").value = Store.ui.colorBy;
    $("#optDeps").checked = Store.ui.showDeps;
    $("#optBase").checked = Store.ui.showBaseline;
    $("#optHl").checked = Store.ui.highlight;
    $("#optOnly").checked = Store.ui.onlyFocus;
    if (document.activeElement !== $("#focusRoles")) $("#focusRoles").value = roles.join(", ");
    $("#ganttLegend").innerHTML =
      legendHtml(gp) +
      (Store.ui.highlight && roles.length ? `<span><i class="lg-focus"></i>${U.esc(roleLabel)} 任務</span>` : "") +
      (Store.ui.showBaseline ? `<span><i class="lg-base"></i>基準（原 Excel）</span>` : "") +
      (cdMap && cdMap.size ? CloudDiff.legendHtml() : "") +
      `<span><i class="lg-ms"></i>單日里程碑</span>` +
      `<span><i class="lg-hol"></i>${Store.ui.zoom === "day" ? "非工作日" : "假日"}（${U.esc(gp.calendar)}）</span>`;

    const laneDock = {};
    if (v.mode === "group") for (const b of v.merged.perBuild) if (b.key.dock) laneDock[b.p.id + ":lane"] = b.key.dock.start;
    Gantt.render($("#gantt"), gp, gs, {
      ui: Store.ui,
      tip,
      diff: cdMap,
      defaultCollapsed: v.mode === "group" ? v.merged.defaults : null,
      laneDock,
      onToggle(id, wasCollapsed) {
        const c = Object.assign({}, Store.ui.collapsed);
        c[gp.id] = Object.assign({}, c[gp.id], { [id]: !wasCollapsed });
        Store.setUi({ collapsed: c });
      },
      onPick(id) {
        const i = id.indexOf(":");
        if (v.mode === "group" && i > 0) {
          const pid = id.slice(0, i);
          const tid = id.slice(i + 1);
          if (tid === "lane") return;
          if (Store.ui.tableTab[v.id] !== pid) Store.setUi({ tableTab: Object.assign({}, Store.ui.tableTab, { [v.id]: pid }) });
          focusRow(tid);
        } else focusRow(id);
      },
    });

    // ---- raw data (always one sheet; tabs switch builds in a group)
    const p = v.pfam;
    const ps = Store.sched(p);
    $("#tableTabs").innerHTML =
      v.mode === "group"
        ? `<span class="muted">編輯分頁：</span>` +
          v.g.members
            .map((m) => `<button type="button" role="tab" class="tab${m.p.id === p.id ? " on" : ""}" data-tab="${m.p.id}" aria-selected="${m.p.id === p.id}"><span class="build-pill">${U.esc(m.build)}</span>${U.esc(m.p.sheet)}</button>`)
            .join("")
        : "";
    const scope = v.mode === "group" ? `（${U.esc(v.g.members.find((m) => m.p.id === p.id).build)} 分頁）` : "";
    $("#asmScope").innerHTML = scope;
    const ta = $("#asmText");
    if (document.activeElement !== ta) ta.value = p.assumptions || "";
    autoGrow(ta);
    $("#asmCount").textContent = p.assumptions ? "" : "（尚無內容）";

    renderInfoForm(p);
    const tableDiff = cdOn ? CloudDiff.taskMap(cdEntries.filter((e) => e.p.id === p.id), false) : null;
    Table.render($("#tableWrap"), p, ps, tableDiff);
    $("#rawCount").textContent = `${p.tasks.filter((t) => t.type === "task").length} 個任務${scope}`;
    $("#baselineNote").textContent = p.baselineLabel
      ? `基準：${p.baselineLabel}`
      : p.baselineAt ? `基準：${p.baselineAt.slice(0, 16).replace("T", " ")} 設定` : `基準：匯入的 Excel 日期`;
  }

  function renderInfoForm(p) {
    const f = $("#infoForm");
    if (f.contains(document.activeElement)) return;
    const cals = Object.keys(Store.data.calendars);
    const field = (k, label, v, attrs) => `<label><span>${label}</span><input data-pf="${k}" value="${U.esc(v || "")}" ${attrs || ""}></label>`;
    const auto = Groups.autoKey(p);
    f.innerHTML = `
      ${field("sheet", "PFAM 名稱", p.sheet, 'required aria-required="true"')}
      ${field("title", "標題", p.title)}
      ${field("site", "廠區", p.site)}
      <label><span>假日曆</span><select data-pf="calendar">${cals.map((c) => `<option${c === p.calendar ? " selected" : ""}>${c}</option>`).join("")}</select></label>
      ${field("meta.lead", "Project Lead", p.meta.lead)}
      ${field("meta.mdm", "MDM", p.meta.mdm)}
      ${field("meta.l10pn", "L10 PN", p.meta.l10pn)}
      ${field("meta.l11pn", "L11 PN", p.meta.l11pn)}
      ${field("group", "合併群組（留空＝自動，- ＝不合併）", p.group, `placeholder="${U.esc(auto ? "自動：" + auto.replace(/\|/g, " ") : "自動：不合併")}"`)}
      <label class="check"><input type="checkbox" data-pf="hidden"${p.hidden ? " checked" : ""}> 在總覽中隱藏（封存）</label>`;
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight + 2, 600) + "px";
  }

  function focusRow(tid, field) {
    const raw = $("#rawSec");
    raw.open = true;
    Store.setUi({ tableOpen: true });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const tr = $(`#tableWrap tr[data-row="${tid}"]`);
        if (!tr) return;
        tr.scrollIntoView({ block: "center", behavior: "smooth" });
        tr.classList.remove("flash");
        void tr.offsetWidth;
        tr.classList.add("flash");
        const inp = tr.querySelector(`[data-f="${field || "name"}"]`);
        if (inp) inp.focus({ preventScroll: true });
      })
    );
  }

  function select(id, { scroll } = {}) {
    Store.setUi({ selectedId: id });
    if (scroll) requestAnimationFrame(() => $("#detail").scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // ---------------------------------------------------------------- cloud sync
  // Edits stay in this browser until the user presses "同步到雲端" and confirms; nothing is uploaded automatically.

  /** Local edits not yet uploaded: changed PFAMs, deleted PFAMs, holiday calendars, what-if PFAMs of the load page. */
  function localChanges() {
    const ids = [...Store.dirty].filter((id) => Store.pfam(id));
    const deleted = Store.data.deleted || [];
    const calendars = !!Store.data.calendarsDirty;
    const scenarios = !!Store.data.scenariosDirty;
    return { ids, deleted, calendars, scenarios, count: ids.length + deleted.length + (calendars ? 1 : 0) + (scenarios ? 1 : 0) };
  }

  function describeChanges(ch) {
    const parts = [];
    if (ch.ids.length) parts.push(`${ch.ids.length} 個 PFAM 有修改`);
    if (ch.deleted.length) parts.push(`刪除 ${ch.deleted.length} 個 PFAM`);
    if (ch.calendars) parts.push("廠區假日有修改");
    if (ch.scenarios) parts.push("人力負載手動 PFAM 有修改");
    return parts.join("、");
  }

  // Full-screen "please wait" while the cloud is read or written. Loads can be skipped after 10 s
  // (the page keeps showing this browser's copy and swaps in the cloud data when it arrives).
  let blockerTimer = null;
  function showBlocker(msg, { skippable } = {}) {
    const t0 = Date.now();
    $("#blockerMsg").textContent = msg;
    $("#blockerTime").textContent = "";
    $("#blockerSkip").hidden = true;
    $("#blocker").hidden = false;
    clearInterval(blockerTimer);
    blockerTimer = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      $("#blockerTime").textContent = `（已等候 ${s} 秒）`;
      if (skippable && s >= 10) $("#blockerSkip").hidden = false;
    }, 1000);
  }
  function hideBlocker() {
    clearInterval(blockerTimer);
    $("#blocker").hidden = true;
  }

  let hadChanges = false;
  /** Tell the user once when the page goes from "same as cloud" to "has local edits". */
  function noteLocalChange() {
    const has = Remote.active && localChanges().count > 0;
    if (has && !hadChanges)
      toast("修改只存在這個瀏覽器，尚未同步到雲端，其他人看不到。要分享請按上方「同步到雲端」。", "", [{ label: "同步到雲端…", run: syncToCloud }]);
    hadChanges = has;
  }

  async function syncToCloud() {
    const ch = localChanges();
    if (!ch.count) return toast("沒有需要同步的本機修改");
    if (!sync.loaded) return toast("尚未連上雲端，無法同步，請稍後再試。", "error", [{ label: "重試連線", run: () => cloudLoad() }]);
    const lines = [
      ...ch.ids.map((id) => "・" + Store.pfam(id).sheet),
      ...(ch.deleted.length ? [`・刪除 ${ch.deleted.length} 個 PFAM`] : []),
      ...(ch.calendars ? ["・廠區假日設定"] : []),
      ...(ch.scenarios ? ["・人力負載手動新增的 PFAM / task"] : []),
    ];
    const shown = lines.slice(0, 15).join("\n") + (lines.length > 15 ? `\n…另外 ${lines.length - 15} 項` : "");
    if (!confirm(`將以下本機修改上傳到雲端（Google Sheet）？\n上傳後其他人重新整理就會看到。\n\n${shown}`)) return;
    showBlocker("正在上傳到雲端…");
    try {
      await pushDirty();
    } finally {
      hideBlocker();
    }
    if (sync.state === "synced") toast("✓ 已同步到雲端");
  }

  function discardLocal() {
    if (!confirm("捨棄這個瀏覽器所有尚未同步的修改，改為載入雲端最新版本？\n此動作無法復原。")) return;
    cloudLoad({ force: true });
  }

  async function pushDirty() {
    if (!Remote.active || !sync.loaded) return;
    const ids = [...Store.dirty].filter((id) => Store.pfam(id));
    const deleted = Store.data.deleted || [];
    if (!ids.length && !deleted.length && !Store.data.calendarsDirty && !Store.data.scenariosDirty) return;
    setSync("syncing");
    try {
      for (const id of deleted.slice()) {
        await Remote.deletePfam(id);
        Store.data.deleted = (Store.data.deleted || []).filter((x) => x !== id);
        Store.setCloudPfam(id, null);
      }
      if (Store.data.calendarsDirty) {
        await Remote.saveCalendars(Store.data.calendars);
        Store.data.calendarsDirty = false;
      }
      if (Store.data.scenariosDirty) {
        const sent = Store.data.scenarios; // replaced (not mutated) on every edit
        await Remote.saveScenarios(sent);
        if (Store.data.scenarios === sent) Store.data.scenariosDirty = false;
      }
      for (const id of ids) {
        const p = Store.pfam(id);
        if (!p) continue;
        const rev = p._rev;
        const sent = JSON.parse(JSON.stringify(p)); // edits made during the upload are not in the cloud
        const r = await Remote.savePfam(p);
        if (r.conflict) {
          setSync("conflict", `「${p.sheet}」在雲端已被其他人更新`);
          toast(`「${p.sheet}」在雲端已被更新，無法自動合併。`, "error", [
            { label: "載入雲端版本", run: () => cloudLoad({ force: true }) },
            { label: "以本機覆寫", run: () => forcePush(id) },
          ]);
          return;
        }
        p.version = r.version;
        Store.setCloudPfam(id, sent);
        if (p._rev === rev) Store.markClean([id]);
      }
      Store.persist();
      setSync("synced");
    } catch (err) {
      setSync("error", err.message);
    }
  }

  async function forcePush(id) {
    const p = Store.pfam(id);
    if (!p) return;
    setSync("syncing");
    try {
      const sent = JSON.parse(JSON.stringify(p));
      const r = await Remote.savePfam(p, true);
      p.version = r.version;
      Store.setCloudPfam(id, sent);
      Store.markClean([id]);
      Store.persist();
      setSync("synced");
      pushDirty(); // finish the rest of the confirmed sync
    } catch (err) {
      setSync("error", err.message);
    }
  }

  function setSync(state, msg) {
    sync.state = state;
    sync.msg = msg || "";
    if (state === "synced") sync.at = new Date();
    renderSoon("status");
    if (state === "synced") renderSoon("list", "detail"); // unsynced markers may have cleared
  }

  async function cloudLoad({ force, quiet } = {}) {
    if (!Remote.active) return;
    setSync("syncing");
    if (!quiet) showBlocker("正在同步雲端資料…", { skippable: true });
    try {
      const data = await Remote.loadAll().finally(hideBlocker);
      sync.loaded = true;
      Store.setCloud(data.pfams || []); // what local edits are compared with, even when they are kept
      renderSoon("list", "detail");
      if (!data.pfams || !data.pfams.length) {
        setSync("synced");
        toast("雲端試算表目前是空的。可在「雲端同步」中上傳本機資料。", "", [{ label: "開啟設定", run: openCloud }]);
        return;
      }
      const ch = localChanges();
      if (!force && ch.count) {
        const ok = confirm(`這個瀏覽器有尚未同步的本機修改（${describeChanges(ch)}）。\n\n確定：捨棄本機修改，改用雲端最新版本\n取消：保留本機修改（之後可按「同步到雲端」上傳）`);
        if (!ok) {
          setSync("synced");
          return;
        }
      }
      Store.replaceData(data);
      setSync("synced");
      renderSoon("filters", "list", "detail", "status");
    } catch (err) {
      setSync("error", err.message);
      if (sync.loaded) toast("雲端載入失敗：" + err.message, "error");
      else toast("無法連線雲端，目前顯示本機備份資料（可能不是最新）。", "error", [{ label: "重試", run: () => cloudLoad() }]);
    }
  }

  /** While the cloud has never been reached this session, keep retrying the initial load (uploads are always manual). */
  function retrySync() {
    if (Remote.active && sync.state === "error" && !sync.loaded) cloudLoad({ quiet: true });
  }

  // ---------------------------------------------------------------- dialogs
  const GAS_RE = /^https:\/\/script\.google\.com\/.+\/exec$/;

  /** "index.html?gas=<exec url>" turns cloud sync on for this browser (the edit key is never in the link). */
  function applyShareLink() {
    const params = new URLSearchParams(location.search);
    const gas = params.get("gas");
    if (!gas) return;
    params.delete("gas");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    if (!GAS_RE.test(gas)) return toast("分享連結裡的 Apps Script 網址格式不正確", "error");
    if (Remote.config.url !== gas || !Remote.config.enabled) {
      Remote.saveConfig({ url: gas, enabled: true });
      toast("已從分享連結啟用 Google Sheet 同步");
    }
  }

  function shareLink(url) {
    const base = location.href.split(/[?#]/)[0];
    return `${base}?gas=${encodeURIComponent(url)}`;
  }

  function openCloud() {
    const d = $("#dlgCloud");
    $("#cloudUrl").value = Remote.config.url;
    $("#cloudKey").value = Remote.config.key;
    $("#cloudMsg").textContent = Remote.active ? "目前已啟用雲端同步。" : "目前為本機模式。";
    d.showModal();
  }

  function openHolidays() {
    const d = $("#dlgHol");
    const sel = $("#holSite");
    const cals = Store.data.calendars;
    sel.innerHTML = Object.keys(cals).map((k) => `<option>${k}</option>`).join("");
    const p = editPfam();
    sel.value = p ? p.calendar : Object.keys(cals)[0];
    fillHolidays();
    d.showModal();
  }
  function fillHolidays() {
    const cal = Store.data.calendars[$("#holSite").value];
    $("#holText").value = cal ? cal.holidays.map((h) => `${h.date}  ${h.name || ""}`.trim()).join("\n") : "";
    $("#holMsg").textContent = cal ? `${cal.holidays.length} 天` : "";
  }
  function saveHolidays() {
    const site = $("#holSite").value;
    const lines = $("#holText").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    const bad = [];
    for (const l of lines) {
      const m = l.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s*(.*)$/);
      if (!m) {
        bad.push(l);
        continue;
      }
      out.push({ date: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, name: m[4] || "" });
    }
    if (bad.length) {
      $("#holMsg").textContent = `無法解析 ${bad.length} 行，例如「${bad[0]}」。格式：2027-01-01 名稱`;
      return false;
    }
    const uniq = [...new Map(out.map((h) => [h.date, h])).values()].sort((a, b) => a.date.localeCompare(b.date));
    const cals = JSON.parse(JSON.stringify(Store.data.calendars));
    cals[site] = { site, holidays: uniq };
    Store.setCalendars(cals);
    toast(`${site} 假日已更新（${uniq.length} 天），所有使用此日曆的排程已重算`);
    return true;
  }

  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------- events
  function bind() {
    Store.subscribe((reason, detail) => {
      if (reason === "data") {
        renderSoon("list", "detail", "load", "status");
        if (detail && (detail.replaced || detail.deleted)) renderSoon("filters");
        noteLocalChange();
      }
      if (reason === "ui") {
        if (detail && "page" in detail) renderSoon("page", "filters");
        if (detail && ("showHidden" in detail || "filters" in detail)) renderSoon("filters");
        if (detail && "theme" in detail) applyTheme();
        renderSoon("list", "detail", "load");
      }
      if (reason === "saveState") renderSoon("status");
    });

    // page tabs
    $("#pageTabs").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-page]");
      if (!b || b.dataset.page === Store.ui.page) return;
      Store.setUi({ page: b.dataset.page });
      window.scrollTo({ top: 0 });
    });
    Load.bind({
      tip,
      // A grouped PFAM opens the merged view with the task's build in the raw table.
      onOpen(unitId, pfamId, taskId) {
        tip.hide();
        const patch = { page: "overview", selectedId: unitId };
        if (unitId !== pfamId) patch.tableTab = Object.assign({}, Store.ui.tableTab, { [unitId]: pfamId });
        Store.setUi(patch);
        focusRow(taskId);
      },
    });

    // portfolio
    const filters = $("#pfFilters");
    filters.addEventListener("input", (ev) => {
      if (ev.target.id === "pfSearch") Store.setUi({ search: ev.target.value });
    });
    filters.addEventListener("change", (ev) => {
      if (ev.target.id === "pfSort") Store.setUi({ sort: ev.target.value });
      if (ev.target.id === "pfHidden") Store.setUi({ showHidden: ev.target.checked });
      if (ev.target.id === "pfFull") Store.setUi({ pfFullRange: ev.target.checked });
    });
    filters.addEventListener("click", (ev) => {
      const pv = ev.target.closest("[data-pfview]");
      if (pv) {
        Store.setUi({ pfView: pv.dataset.pfview });
        renderSoon("filters");
      }
      const c = ev.target.closest("[data-fk]");
      if (c) {
        const f = JSON.parse(JSON.stringify(Store.ui.filters));
        const arr = f[c.dataset.fk] || [];
        const v = c.dataset.fv;
        // "全部" (empty value) clears the group
        f[c.dataset.fk] = !v ? [] : arr.includes(v) ? arr.filter((x) => x !== v) : arr.concat(v);
        Store.setUi({ filters: f });
      }
      if (ev.target.id === "pfClear") {
        Store.setUi({ filters: { gen: [], site: [], phase: [], sku: [] }, search: "" });
        renderSoon("filters");
      }
    });
    const list = $("#pfList");
    list.addEventListener("click", (ev) => {
      const ex = ev.target.closest("[data-expand]");
      if (ex) {
        const e = Object.assign({}, Store.ui.pfExpanded);
        e[ex.dataset.expand] = !e[ex.dataset.expand];
        Store.setUi({ pfExpanded: e });
        return;
      }
      const r = ev.target.closest("[data-pfam]");
      if (r) select(r.dataset.pfam, { scroll: true });
    });
    list.addEventListener("keydown", (ev) => {
      const r = ev.target.closest("[data-pfam]");
      if (!r) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        select(r.dataset.pfam, { scroll: true });
      }
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const rows = [...list.querySelectorAll("[data-pfam]")];
        const next = rows[rows.indexOf(r) + (ev.key === "ArrowDown" ? 1 : -1)];
        if (next) next.focus();
      }
    });
    list.addEventListener("mousemove", (ev) => {
      const r = ev.target.closest(".c-tl");
      const row = ev.target.closest("[data-pfam]");
      if (!r || !row) return tip.hide();
      if (row.dataset.pfam.startsWith("g:")) {
        const g = Groups.find(row.dataset.pfam);
        if (!g) return tip.hide();
        const m = Groups.merged(g);
        tip.show(
          `<div class="tip-title">${U.esc(g.name)}</div>` +
            m.perBuild
              .map((b) => `<div class="tip-row"><span>${U.esc(b.build)}</span><b>L10 ${b.key.build ? U.fmt(b.key.build.start, "md") : "—"} · ETD ${b.key.etd ? U.fmt(b.key.etd.start, "md") : "—"} · Dock ${b.key.dock ? U.fmt(b.key.dock.start) : "—"}</b></div>`)
              .join("") +
            `<div class="tip-notes">2nd 只計入量產段（前段多沿用 1st）。點擊查看合併甘特圖</div>`,
          ev
        );
        return;
      }
      const p = Store.pfam(row.dataset.pfam);
      const s = Store.sched(p);
      const k = U.keyDates(p, s);
      tip.show(
        `<div class="tip-title">${U.esc(p.sheet)}</div>
         <div class="tip-row"><span>期間</span><b>${U.fmt(s.span.start)} → ${U.fmt(s.span.end)}</b></div>
         ${k.build ? `<div class="tip-row"><span>L10 Build</span><b>${U.fmt(k.build.start, "full")}</b></div>` : ""}
         ${k.etd ? `<div class="tip-row"><span>ETD</span><b>${U.fmt(k.etd.start, "full")}</b></div>` : ""}
         ${k.dock ? `<div class="tip-row"><span>Dock</span><b>${U.fmt(k.dock.start, "full")}</b></div>` : ""}
         ${k.dockDelta ? `<div class="tip-row"><span>相對基準</span><b class="${k.dockDelta > 0 ? "late" : "early"}">${U.signedDays(k.dockDelta)}</b></div>` : ""}
         <div class="tip-notes">點擊查看甘特圖</div>`,
        ev
      );
    });
    list.addEventListener("mouseleave", tip.hide);
    new ResizeObserver(U.debounce(() => renderSoon("list"), 120)).observe(list);

    // detail header
    $("#detailHead").addEventListener("click", (ev) => {
      const nav = ev.target.closest("[data-nav]");
      if (nav) {
        const items = Portfolio.items();
        const i = items.findIndex((it) => it.id === Store.ui.selectedId);
        const next = items[i + Number(nav.dataset.nav)];
        if (next) select(next.id);
      }
      const open = ev.target.closest("[data-open]");
      if (open) select(open.dataset.open);
      if (ev.target.id === "btnDup") {
        const c = Store.duplicatePfam(editPfam().id);
        select(c.id);
        renderSoon("filters");
        toast(`已建立「${c.sheet}」，可在下方專案資訊修改名稱`);
      }
      if (ev.target.id === "btnDelPfam") {
        const p = editPfam();
        if (confirm(`確定刪除「${p.sheet}」？此動作無法復原${Remote.active ? "，且會同步刪除雲端資料" : ""}。`)) {
          Store.deletePfam(p.id);
          toast("已刪除");
        }
      }
    });

    // gantt toolbar
    document.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => Store.setUi({ zoom: b.dataset.zoom })));
    $("#colorBy").addEventListener("change", (ev) => Store.setUi({ colorBy: ev.target.value }));
    $("#optDeps").addEventListener("change", (ev) => Store.setUi({ showDeps: ev.target.checked }));
    $("#optBase").addEventListener("change", (ev) => Store.setUi({ showBaseline: ev.target.checked }));
    $("#optHl").addEventListener("change", (ev) => Store.setUi({ highlight: ev.target.checked }));
    $("#optOnly").addEventListener("change", (ev) => Store.setUi({ onlyFocus: ev.target.checked }));
    $("#focusRoles").addEventListener("change", (ev) => Store.setUi({ focusRoles: U.parseRoles(ev.target.value) }));
    $("#btnToday").addEventListener("click", () => Gantt.scrollToDay && Gantt.scrollToDay(E.toDay(new Date().toISOString().slice(0, 10))));
    $("#btnCollapse").addEventListener("click", () => {
      const v = view();
      if (!v) return;
      const gp = v.mode === "group" ? v.merged.pfam : v.pfam;
      const defaults = v.mode === "group" ? v.merged.defaults : new Set();
      const secs = gp.tasks.filter((t) => t.type === "section");
      const cur = Store.ui.collapsed[gp.id] || {};
      const isC = (id) => (id in cur ? !!cur[id] : defaults.has(id));
      const allCollapsed = secs.every((t) => isC(t.id));
      const c = Object.assign({}, Store.ui.collapsed);
      c[gp.id] = allCollapsed ? Object.fromEntries(secs.map((t) => [t.id, defaults.has(t.id)])) : Object.fromEntries(secs.map((t) => [t.id, true]));
      Store.setUi({ collapsed: c });
    });

    // assumptions
    const ta = $("#asmText");
    ta.addEventListener("input", () => autoGrow(ta));
    ta.addEventListener("change", () => Store.updatePfam(editPfam().id, { assumptions: ta.value }, "編輯假設與風險"));

    // raw section
    $("#rawSec").addEventListener("toggle", (ev) => Store.setUi({ tableOpen: ev.target.open }));
    $("#tableTabs").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-tab]");
      const v = view();
      if (b && v && v.mode === "group") Store.setUi({ tableTab: Object.assign({}, Store.ui.tableTab, { [v.id]: b.dataset.tab }) });
    });
    $("#infoForm").addEventListener("change", (ev) => {
      const k = ev.target.dataset.pf;
      if (!k) return;
      const v = ev.target.type === "checkbox" ? ev.target.checked : ev.target.value;
      if (k === "sheet" && !String(v).trim()) {
        toast("PFAM 名稱不能空白", "error");
        ev.target.value = editPfam().sheet;
        return;
      }
      const patch = k.startsWith("meta.") ? { meta: { [k.slice(5)]: v } } : { [k]: v };
      Store.updatePfam(editPfam().id, patch);
      if (k === "hidden" || k === "sheet" || k === "group") renderSoon("filters", "list");
    });
    $("#btnAddSection").addEventListener("click", () => {
      const t = Store.insertTask(editPfam().id, null, "section");
      if (t) focusRow(t.id, "name");
    });
    $("#btnAddTask").addEventListener("click", () => {
      const t = Store.insertTask(editPfam().id, null, "task");
      if (t) focusRow(t.id, "name");
    });
    $("#btnRebase").addEventListener("click", () => {
      if (confirm("把目前計算出的日期設為新的基準？\n之後的「vs 基準」與甘特圖基準線都會以此為準（可 Ctrl+Z 復原）。")) Store.rebaseline(editPfam().id);
    });
    $("#btnRevert").addEventListener("click", () => {
      const p = editPfam();
      if (!Store.fromExcel(p)) return toast("此 PFAM 是在網頁上建立的，沒有 Excel 版本可還原", "error");
      if (!Store.webEdited(p)) return toast("此分頁與最近一次匯入的 Excel 相同，不需要還原");
      if (confirm(`把「${p.sheet}」還原為 Excel 匯入時的內容？（可 Ctrl+Z 復原）`)) Store.revertPfam(p.id);
    });

    // top bar
    $("#btnUndo").addEventListener("click", doUndo);
    $("#btnRedo").addEventListener("click", doRedo);
    $("#btnTheme").addEventListener("click", () => {
      const order = ["dark", "light", "auto"];
      Store.setUi({ theme: order[(order.indexOf(Store.ui.theme) + 1) % 3] });
    });
    $("#syncChip").addEventListener("click", openCloud);
    $("#btnSync").addEventListener("click", syncToCloud);
    $("#cloudDiff").addEventListener("click", (ev) => {
      if (ev.target.closest('[data-cd="sync"]')) syncToCloud();
    });
    $("#cloudDiff").addEventListener("change", (ev) => {
      if (ev.target.dataset.cd === "mark") Store.setUi({ showCloudDiff: ev.target.checked });
    });
    $("#bannerSync").addEventListener("click", syncToCloud);
    $("#bannerDiscard").addEventListener("click", discardLocal);
    $("#blockerSkip").addEventListener("click", hideBlocker);
    const menu = $("#dataMenu");
    $("#btnData").addEventListener("click", (ev) => {
      ev.stopPropagation();
      menu.hidden = !menu.hidden;
      $("#btnData").setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("click", (ev) => {
      if (!menu.hidden && !menu.contains(ev.target)) {
        menu.hidden = true;
        $("#btnData").setAttribute("aria-expanded", "false");
      }
    });
    menu.addEventListener("click", (ev) => {
      const act = ev.target.closest("[data-menu]");
      if (!act) return;
      menu.hidden = true;
      const a = act.dataset.menu;
      if (a === "export") {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
        download(`Gen12AMD_Pilot_gantt-${stamp}.json`, JSON.stringify(Store.exportJson(), null, 1));
      }
      if (a === "import") $("#fileImport").click();
      if (a === "xlsx") XlImport.open();
      if (a === "reset" && confirm("清除本機所有修改，重新載入 Excel 匯入的原始資料？\n（建議先匯出 JSON 備份）")) {
        Store.resetToSeed();
        renderSoon("filters");
        toast("已重設為 Excel 原始資料");
      }
      if (a === "cloud") openCloud();
      if (a === "holidays") openHolidays();
    });
    $("#fileImport").addEventListener("change", async (ev) => {
      const f = ev.target.files[0];
      ev.target.value = "";
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (data.schema !== 1 || !Array.isArray(data.pfams) || !data.calendars) throw new Error("不是本系統匯出的 JSON");
        if (!confirm(`匯入「${f.name}」（${data.pfams.length} 個 PFAM）並取代目前的本機資料？`)) return;
        Store.replaceData(data);
        renderSoon("filters");
        toast("匯入完成");
      } catch (err) {
        toast("匯入失敗：" + err.message, "error");
      }
    });

    // cloud dialog
    $("#cloudTest").addEventListener("click", async () => {
      const url = $("#cloudUrl").value.trim();
      $("#cloudMsg").textContent = "測試中…";
      try {
        await Remote.ping(url);
        $("#cloudMsg").textContent = "✓ 連線成功";
      } catch (err) {
        $("#cloudMsg").textContent = "✗ " + err.message;
      }
    });
    $("#cloudSave").addEventListener("click", async () => {
      const url = $("#cloudUrl").value.trim();
      if (!GAS_RE.test(url)) {
        $("#cloudMsg").textContent = "網址格式應為 https://script.google.com/macros/s/…/exec";
        return;
      }
      Remote.saveConfig({ url, key: $("#cloudKey").value, enabled: true });
      $("#dlgCloud").close();
      await cloudLoad();
    });
    $("#cloudUpload").addEventListener("click", async () => {
      const url = $("#cloudUrl").value.trim();
      if (!url) return ($("#cloudMsg").textContent = "請先填入網址");
      if (!confirm("以本機全部資料覆蓋雲端試算表？雲端現有內容會被取代。")) return;
      Remote.saveConfig({ url, key: $("#cloudKey").value, enabled: true });
      $("#cloudMsg").textContent = "上傳中…（約需數十秒）";
      setSync("syncing");
      try {
        const r = await Remote.uploadAll(Store.exportJson());
        for (const p of Store.data.pfams) if (r.versions && r.versions[p.id] != null) p.version = r.versions[p.id];
        Store.data.deleted = [];
        Store.data.calendarsDirty = false;
        Store.data.scenariosDirty = false;
        Store.setCloud(Store.data.pfams);
        Store.markClean([...Store.dirty]);
        Store.persist.now();
        $("#cloudMsg").textContent = `✓ 已上傳 ${r.pfams} 個 PFAM、${r.tasks} 個任務`;
        setSync("synced");
      } catch (err) {
        $("#cloudMsg").textContent = "✗ " + err.message;
        setSync("error", err.message);
      }
    });
    $("#cloudShare").addEventListener("click", async () => {
      const url = $("#cloudUrl").value.trim();
      if (!GAS_RE.test(url)) return ($("#cloudMsg").textContent = "請先填入正確的 Apps Script 網址（結尾 /exec）");
      const link = shareLink(url);
      try {
        await navigator.clipboard.writeText(link);
        $("#cloudMsg").textContent = "✓ 已複製分享連結（不含 Edit key）：" + link;
      } catch {
        $("#cloudMsg").textContent = "分享連結（請手動複製）：" + link;
      }
    });
    $("#cloudOff").addEventListener("click", () => {
      Remote.saveConfig({ enabled: false });
      setSync("local");
      $("#dlgCloud").close();
      toast(Remote.builtIn ? "已暫時切換為本機模式，重新整理頁面會回到雲端" : "已切換為本機模式");
    });

    // holidays dialog
    $("#holSite").addEventListener("change", fillHolidays);
    $("#holSave").addEventListener("click", () => {
      if (saveHolidays()) $("#dlgHol").close();
    });

    // keyboard
    document.addEventListener("keydown", (ev) => {
      const inField = ev.target.closest && ev.target.closest("input, textarea, select");
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && !inField && ev.key.toLowerCase() === "z" && !ev.shiftKey) {
        ev.preventDefault();
        doUndo();
      }
      if (mod && !inField && (ev.key.toLowerCase() === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey))) {
        ev.preventDefault();
        doRedo();
      }
      if (ev.key === "Escape") tip.hide();
    });
  }

  function doUndo() {
    const l = Store.undo();
    if (l) toast(`已復原：${l}`);
  }
  function doRedo() {
    const l = Store.redo();
    if (l) toast(`已重做：${l}`);
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    if (!window.NPI_SEED) {
      document.body.innerHTML = `<p style="padding:24px">找不到 data/seed.js，請先執行 <code>python tools/excel_to_seed.py &lt;xlsx&gt;</code>。</p>`;
      return;
    }
    Store.init();
    applyTheme();
    $("#rawSec").open = Store.ui.tableOpen;
    bind();
    XlImport.bind();
    renderSoon("page", "filters", "list", "detail", "load", "status");
    applyShareLink();
    if (Remote.active) cloudLoad();
    setInterval(retrySync, 60000);
    window.addEventListener("online", retrySync);
    document.addEventListener("visibilitychange", () => !document.hidden && retrySync());
  }

  window.App = { toast, renderSoon: () => renderSoon("detail"), focusRow, isShowing };
  document.addEventListener("DOMContentLoaded", boot);
})();
