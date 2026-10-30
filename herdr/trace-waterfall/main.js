import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { focused, panes, props, settings, spaces, terminals, theme, watchFolder } from "herdr";
import {
  displayEnd,
  domainOf,
  figuresOf,
  followedIndex,
  formatCost,
  formatDuration,
  formatTick,
  formatTokens,
  isLive,
  promptLine,
  rowCosts,
  rowsOf,
  slowestLeaf,
  subtreeOf,
  ticksOf,
} from "./trace.js";
import { COST_WIDTH, DURATION_WIDTH, GUTTER, PALETTES, colorOf, detailOf, indentOf, layoutOf, nameWidthOf } from "./draw.js";
import { fileName, liveFolder, readTrace, sameName } from "./live.js";

const TEXT = 12;
const CHAR = TEXT * 0.6;
const ROW = 24;
const BAR = 14;
const PAD = 12;
const LINE = 18;
const RECHECK = 10000;
const RETRY = 5000;
const PROMPT_LINES = 6;

const SENTENCES = {
  none: "Focus a terminal to see the trace of its Claude Code session.",
  missing: "No trace for this terminal. It appears once Claude Code runs here with the trace-waterfall mod.",
  remote: "This terminal runs on another machine. The panel shows the traces of terminals on this computer only.",
  empty: "No request has run yet in this Claude Code session.",
  unreadable: "The trace file of this terminal could not be read. The panel reads it again when the file changes.",
};

function isDark(color) {
  const hex = /^#([0-9a-f]{6})/i.exec(String(color ?? ""))?.[1];
  if (hex === undefined) return true;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

function itemsOf(figures, palette) {
  return [
    { label: "Duration", value: formatDuration(figures.duration), width: 7 },
    { label: "Cost", value: formatCost(figures.cost) || "none", width: 6 },
    { label: "Tokens in", value: formatTokens(figures.tokensIn), width: 6 },
    { label: "out", value: formatTokens(figures.tokensOut), width: 6 },
    { label: "Model calls", value: String(figures.modelCalls), width: 4, swatch: palette.model },
    { label: "Tool calls", value: String(figures.toolCalls), width: 4, swatch: palette.tool },
    { label: "Errors", value: String(figures.errors), width: 3, swatch: palette.error },
  ];
}

export default class TraceWaterfall extends View {
  init(_props, cx) {
    this.width = 420;
    this.entries = new Map();
    this.views = new Map();
    this.terminal = null;
    this.lastFocused = null;
    this.folder = null;
    this.shown = null;
    this.ticking = false;
    this.focus = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.watch(cx);
    cx.timer.every(1000, (cx) => {
      if (this.ticking) cx.notify();
    });
  }

  async close() {
    this.scroll?.release();
  }

  watch(cx) {
    cx.spawn(async (cx) => {
      this.folder = await liveFolder();
      this.reload(cx);
      let waiting = null;
      for (;;) {
        waiting ??= watchFolder(this.folder.dir).then(
          (paths) => ({ paths }),
          () => ({ failed: true }),
        );
        const result = await Promise.race([waiting, cx.sleep(RECHECK).then(() => null)]);
        if (result === null) {
          this.reload(cx);
          continue;
        }
        waiting = null;
        if (result.failed) {
          await cx.sleep(RETRY);
          this.reload(cx);
          continue;
        }
        const terminal = this.terminal;
        if (terminal && result.paths.some((path) => sameName(path, fileName(terminal), this.folder.windows))) this.reload(cx);
      }
    });
  }

  reload(cx) {
    const terminal = this.terminal;
    if (!terminal || !this.folder || terminal.includes("/")) return;
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      let result;
      try {
        result = await readTrace(this.folder, terminal);
      } catch {
        result = { state: "unreadable" };
      }
      this.loading = false;
      const changed = this.apply(terminal, result);
      if (this.again || terminal !== this.terminal) {
        this.again = false;
        this.reload(cx);
      }
      if (changed) cx.notify();
    });
  }

  apply(terminal, result) {
    const old = this.entries.get(terminal);
    if (result.state === "ok") {
      if (old?.state === "ok" && old.content === result.content) return false;
      this.entries.set(terminal, { state: "ok", content: result.content, doc: result.doc });
      return true;
    }
    if (result.state === "unreadable" && old?.doc) return false;
    if (old?.state === result.state && old?.format === result.format) return false;
    this.entries.set(terminal, { state: result.state, format: result.format, doc: null });
    return true;
  }

  wanted() {
    const own = props()?.terminal;
    if (typeof own === "string" && own !== "") return own;
    const now = focused()?.terminal;
    if (now) this.lastFocused = now;
    return this.lastFocused;
  }

  viewOf(terminal, doc) {
    let view = this.views.get(terminal);
    if (view === undefined) {
      view = { trace: null, selected: null, main: doc.main };
      this.views.set(terminal, view);
    }
    if (view.main !== doc.main) {
      view.main = doc.main;
      view.trace = null;
    }
    return view;
  }

  followed(doc) {
    const at = doc.main === null ? -1 : doc.traces.findIndex((one) => one.id === doc.main);
    return at < 0 ? followedIndex(doc.traces) : at;
  }

  alive(terminal) {
    const found = terminals().find((one) => one.address === terminal);
    return found !== undefined && found.state === "live" && found.program?.agent !== false;
  }

  where(terminal) {
    const pane = panes().find((one) => one.terminal === terminal);
    const space = pane ? spaces().find((one) => one.tabs.some((tab) => tab.id === pane.tab)) : undefined;
    const tab = space?.tabs.find((one) => one.id === pane.tab);
    return space && tab ? `${space.name} / ${tab.name} (${terminal})` : terminal;
  }

  move(step, cx) {
    const shown = this.shown;
    if (!shown) return;
    const { traces, index, view, followed } = shown;
    const target = Math.min(traces.length - 1, Math.max(0, index + step));
    if (target === index) return;
    view.trace = target === followed ? null : (traces[target]?.id ?? null);
    view.selected = null;
    cx.notify();
  }

  select(id, cx) {
    const view = this.shown?.view;
    if (!view || view.selected === id) return;
    view.selected = id;
    cx.notify();
  }

  toggle(id, cx) {
    this.focus.focus();
    const view = this.shown?.view;
    if (!view) return;
    this.select(view.selected === id ? null : id, cx);
  }

  key(e, cx) {
    const shown = this.shown;
    if (!shown) return;
    const { rows, view } = shown;
    if (e.key === "escape" && view.selected !== null) {
      this.select(null, cx);
      cx.stop_propagation();
    } else if (e.key === "up" || e.key === "down") {
      const at = rows.findIndex((row) => row.span.id === view.selected);
      const next = at < 0 ? (e.key === "down" ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + (e.key === "down" ? 1 : -1)));
      const row = rows[next];
      if (row) {
        this.select(row.span.id, cx);
        this.scroll.scroll_to_item(next);
      }
      cx.stop_propagation();
    } else if (e.key === "left" || e.key === "right") {
      this.move(e.key === "left" ? -1 : 1, cx);
      cx.stop_propagation();
    }
  }

  sentence(t, text) {
    return div().p(PAD + 2).text_color(t.muted).child(text);
  }

  render(cx) {
    const t = theme();
    const terminal = this.wanted();
    if (terminal !== this.terminal) {
      this.terminal = terminal;
      this.reload(cx);
    }
    this.shown = null;
    this.ticking = false;

    const root = v_flex()
      .id("trace-root")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(TEXT)
      .track_focus(this.focus)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) >= 1) {
          this.width = size.width;
          cx.notify();
        }
      })
      .child(
        h_flex()
          .min_h(42)
          .flex_none()
          .px(14)
          .py(6)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().text_size(13).child("Trace"))
          .child(div().flex_1().min_w(0).text_right().text_color(t.dim).child(terminal ? this.where(terminal) : "")),
      );

    if (!terminal) return root.child(this.sentence(t, SENTENCES.none));
    if (terminal.includes("/")) return root.child(this.sentence(t, SENTENCES.remote));
    const entry = this.entries.get(terminal);
    if (entry === undefined) return root;
    if (entry.state === "missing") return root.child(this.sentence(t, SENTENCES.missing));
    if (entry.state === "format") return root.child(this.sentence(t, `The trace file of this terminal has a format this panel does not read: ${entry.format}.`));
    if (!entry.doc) return root.child(this.sentence(t, SENTENCES.unreadable));
    const traces = entry.doc.traces;
    if (traces.length === 0) return root.child(this.sentence(t, SENTENCES.empty));

    const view = this.viewOf(terminal, entry.doc);
    const followed = this.followed(entry.doc);
    const found = view.trace === null ? -1 : traces.findIndex((one) => one.id === view.trace);
    const index = found < 0 ? followed : found;
    const trace = traces[index];
    const alive = this.alive(terminal);
    const live = alive && isLive(trace);
    const now = alive ? Date.now() : entry.doc.written;
    const palette = PALETTES[(settings()?.dark ?? isDark(t.background)) ? "dark" : "light"];
    const rows = rowsOf(trace);
    const subtree = view.selected === null ? [] : subtreeOf(trace, view.selected, rows);
    const selectedId = subtree.length > 0 ? view.selected : null;
    const figures = figuresOf(selectedId === null ? trace.spans : subtree, now);
    this.shown = { traces, index, view, rows, followed };
    this.ticking = live;

    const bodyPx = Math.max(0, this.width - 2 - 2 * PAD);
    const layout = layoutOf(Math.max(24, Math.floor(bodyPx / CHAR)), nameWidthOf(rows));
    const gutterPx = GUTTER * CHAR;
    const durationPx = DURATION_WIDTH * CHAR;
    const costPx = COST_WIDTH * CHAR;
    const numbersPx = durationPx + (layout.hasCost ? 2 * CHAR + costPx : 0);
    const labelPx = layout.timeline > 0 ? layout.label * CHAR : Math.max(layout.label * CHAR, bodyPx - gutterPx - CHAR - numbersPx);
    const timelinePx = layout.timeline > 0 ? Math.max(0, bodyPx - gutterPx - labelPx - 2 * CHAR - numbersPx) : 0;

    const last = Math.max(trace.start, ...trace.spans.map((span) => displayEnd(span, now)));
    const domain = domainOf(Math.max(1000, last - trace.start));
    const ticks = ticksOf(domain, layout.timeline);
    const x = (at) => ((at - trace.start) / domain) * timelinePx;
    const grid = ticks.filter((tick) => tick > 0).map((tick) => ((tick * 1000) / domain) * timelinePx);
    const nowX = live ? x(now) : null;
    const slowest = slowestLeaf(trace.spans, now);
    const costs = rowCosts(trace);

    const labels = [];
    let free = 0;
    for (const tick of ticks) {
      const at = ((tick * 1000) / domain) * timelinePx;
      const text = formatTick(tick);
      if (at >= free && at + text.length * CHAR <= timelinePx) {
        labels.push(div().absolute().left(at).bottom(0).whitespace_nowrap().child(text));
        free = at + (text.length + 1) * CHAR;
      }
    }

    const button = (id, label, enabled, step) =>
      div()
        .id(id)
        .h(24)
        .px(8)
        .flex()
        .items_center()
        .flex_none()
        .rounded(6)
        .border_1()
        .border_color(t.border)
        .whitespace_nowrap()
        .text_color(enabled ? t.foreground : t.dim)
        .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          if (enabled) this.move(step, cx);
        })
        .child(label);

    const rowOf = ({ span, depth }) => {
      const selected = span.id === selectedId;
      const color = colorOf(span, palette);
      const end = span.id === trace.id ? last : displayEnd(span, now);
      const detail = detailOf(span, depth, layout.label);
      const left = x(span.start);
      const width = Math.max(1, x(end) - left);
      return h_flex()
        .h(ROW)
        .w_full()
        .items_center()
        .whitespace_nowrap()
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .child(
          div()
            .w(gutterPx)
            .h_full()
            .flex_none()
            .relative()
            .when(selected, (el) => el.child(div().absolute().left(2).top(5).bottom(5).w(3).rounded(1).bg(color))),
        )
        .child(
          h_flex()
            .w(labelPx)
            .flex_none()
            .pl(indentOf(depth) * CHAR)
            .child(div().when(selected, (el) => el.font_weight(700)).child(span.name))
            .when(detail !== undefined, (el) => el.child(div().pl(CHAR).text_color(t.muted).child(detail))),
        )
        .when(timelinePx > 0, (el) =>
          el.child(
            div()
              .ml(CHAR)
              .w(timelinePx)
              .h_full()
              .flex_none()
              .relative()
              .children(grid.map((at) => div().absolute().top(0).bottom(0).left(at).w(1).border_l(1).border_dashed().border_color(t.border)))
              .when(nowX !== null, (el) => el.child(div().absolute().top(0).bottom(0).left(nowX).w(1).bg(t.working)))
              .child(div().absolute().top((ROW - BAR) / 2).h(BAR).left(left).w(width).rounded(Math.min(2, width / 10)).bg(color)),
          ),
        )
        .child(
          div()
            .ml(CHAR)
            .w(durationPx)
            .flex_none()
            .text_right()
            .when(span.id === slowest, (el) => el.font_weight(700))
            .child(formatDuration(end - span.start)),
        )
        .when(layout.hasCost, (el) => el.child(div().ml(2 * CHAR).w(costPx).flex_none().text_right().child(formatCost(costs.get(span.id) ?? null))));
    };

    const scope = selectedId === null ? "Whole request" : "Selected";
    const items = itemsOf(figures, palette);

    return root.child(
      v_flex()
        .flex_1()
        .min_h(0)
        .px(PAD)
        .pt(10)
        .gap(4)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .justify_between()
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .flex_wrap()
                .child(div().font_weight(700).whitespace_nowrap().child(`Request ${index + 1} of ${traces.length}`))
                .when(live, (el) => el.child(div().text_color(t.working).child("running"))),
            )
            .child(
              h_flex()
                .gap(6)
                .flex_none()
                .child(button("trace-earlier", "◀ Earlier", index > 0, -1))
                .child(button("trace-later", "Later ▶", index < traces.length - 1, 1)),
            ),
        )
        .child(
          div()
            .flex_none()
            .relative()
            .max_h(PROMPT_LINES * LINE)
            .child(
              div()
                .id("trace-prompt")
                .max_h(PROMPT_LINES * LINE)
                .overflow_y_scroll()
                .line_height(`${LINE}px`)
                .text_color(t.muted)
                .child(promptLine(trace)),
            )
            .child(Scrollbar.vertical("trace-prompt").absolute().inset_0()),
        )
        .child(
          h_flex()
            .flex_wrap()
            .gap_x(3 * CHAR)
            .gap_y(2)
            .child(div().w(13 * CHAR).flex_none().font_weight(700).whitespace_nowrap().child(scope))
            .children(
              items.map((item) =>
                h_flex()
                  .flex_none()
                  .whitespace_nowrap()
                  .when(item.swatch !== undefined, (el) => el.child(div().size(8).mr(CHAR).rounded(1).bg(item.swatch)))
                  .child(div().text_color(t.muted).child(item.label))
                  .child(div().min_w(item.width * CHAR).ml(CHAR).text_right().child(item.value)),
              ),
            ),
        )
        .child(
          h_flex()
            .h(ROW)
            .mt(8)
            .flex_none()
            .items_end()
            .whitespace_nowrap()
            .text_color(t.dim)
            .child(div().w(gutterPx + labelPx).flex_none())
            .when(timelinePx > 0, (el) => el.child(div().ml(CHAR).w(timelinePx).h_full().flex_none().relative().children(labels)))
            .child(div().ml(CHAR).w(durationPx).flex_none().text_right().child("time"))
            .when(layout.hasCost, (el) => el.child(div().ml(2 * CHAR).w(costPx).flex_none().text_right().child("cost"))),
        )
        .child(
          v_flex()
            .flex_shrink(1)
            .min_h(0)
            .h(rows.length * ROW)
            .relative()
            .child(
              v_virtual_list("trace-rows", rows.length, ROW, (at) => rows[at].span.id, (range) => rows.slice(range.start, range.end).map(rowOf))
                .track_scroll(this.scroll)
                .on_item_click((id, cx) => this.toggle(id, cx))
                .size_full(),
            )
            .child(Scrollbar.vertical("trace-rows").absolute().inset_0()),
        )
        .child(div().id("trace-empty").flex_1().min_h(6).on_click((_e, cx) => this.select(null, cx))),
    );
  }
}
