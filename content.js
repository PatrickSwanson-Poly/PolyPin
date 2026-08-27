(function () {
  "use strict";

  console.log("[PolyPin] Content script loaded on", window.location.href);

  // ──────────────────────────────────────────────────────────────────────
  // Section: CALL_SID handling
  //
  // Confirmed live against Studio (see DESIGN_SPEC.md, "Live-page
  // verification pass"): the current conversation's SID shows up in one of
  // two places depending on view:
  //   - full-page view  → path segment:  /conversations/<CALL_SID>
  //   - drawer/list view → query param:  ?conversation_id=<CALL_SID>
  // Regex reused verbatim from PolyTrace_v2's isValidSid.
  // ──────────────────────────────────────────────────────────────────────

  function isValidSid(val) {
    if (!val) return false;
    const trimmed = val.trim();
    const noHyphens = trimmed.replace(/-/g, "");
    if (noHyphens.length === 34 && /^[A-Za-z0-9]+$/.test(noHyphens)) return true;
    if (/^LOCAL-[0-9a-fA-F-]{36}$/.test(trimmed)) return true;
    if (/^AS_CHAT_[0-9a-fA-F-]{36}$/.test(trimmed)) return true;
    return false;
  }

  function getCurrentCallSid() {
    const pathMatch = location.pathname.match(/\/conversations\/([^/]+)/);
    if (pathMatch && isValidSid(pathMatch[1])) return pathMatch[1];

    const queryId = new URLSearchParams(location.search).get("conversation_id");
    if (isValidSid(queryId)) return queryId;

    return null;
  }

  // AS_CHAT_/LOCAL- prefixed SIDs are chat/webchat conversations — no
  // recording, no player, ever. Everything else (the 34-char alphanumeric
  // SIDs) is a voice call, which does have a player, but it mounts into the
  // DOM asynchronously after the turns themselves — see isConversationReady.
  function isVoiceCallSid(sid) {
    return Boolean(sid) && !/^(AS_CHAT_|LOCAL-)/.test(sid);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Section: Panel / anchor finding
  //
  // Reused from PolyTranslate (~/Documents/Tools/Chrome Extensions/
  // PolyTranslate/content.js) — it already solved reliably placing a
  // button in this exact React SPA. Confirmed live that `#conversation-
  // review` alone is sufficient in both full-page and drawer views; the
  // wider fallback list is kept only as defensive padding.
  // ──────────────────────────────────────────────────────────────────────

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getTranscriptPanel(turn) {
    return (
      turn.closest("#conversation-review") ||
      turn.closest("[role='tabpanel']") ||
      turn.closest("main") ||
      turn.closest("aside") ||
      turn.closest("[data-side-panel]") ||
      turn.closest("[role='dialog']") ||
      turn.parentElement?.parentElement?.parentElement
    );
  }

  function getTranscriptPanels() {
    const panels = new Set();
    [...document.querySelectorAll("[data-turn-idx]")].forEach((turn) => {
      if (!isVisible(turn)) return;
      const panel = getTranscriptPanel(turn);
      if (panel && isVisible(panel)) panels.add(panel);
    });
    return [...panels];
  }

  function getFirstTurn(panel) {
    const scope = panel || document;
    const turns = [...scope.querySelectorAll("[data-turn-idx]")].filter(isVisible);
    return turns[0] || null;
  }

  function isInPanelHeader(btn, panel) {
    const scope = panel || document;
    const copyBtn = scope.querySelector('[data-test-id="copy-call-url-btn"]');
    if (copyBtn?.parentElement?.contains(btn)) return true;
    return Boolean(btn.closest('[data-test-id="conversation-review-header"]'));
  }

  // Full-page header: title block next to an icon cluster (Notes,
  // diagnosis, copy link, etc). Confirmed absent entirely in drawer view —
  // that's why findConversationHeaderAnchor can return null there, and
  // getNotesToolbarAnchor is the fallback that actually fires in that case.
  function getConversationHeaderIconCluster(panel) {
    const scope = panel || document;
    const title = scope.querySelector('[data-test-id="conversation-call-header"]');
    const titleBlock = title?.parentElement;
    const headerRow = titleBlock?.parentElement;
    if (!headerRow) return null;
    return [...headerRow.children].find((child) => child !== titleBlock) || null;
  }

  function findConversationHeaderAnchor(panel) {
    const iconCluster = getConversationHeaderIconCluster(panel);
    if (!iconCluster) return null;
    return { el: iconCluster, insertBefore: iconCluster.firstChild };
  }

  function findNotesButton(panel) {
    const scope = panel || document;
    return (
      scope.querySelector('[data-test-id="conversation-note-btn"]') ||
      [...scope.querySelectorAll("button")].find((btn) => {
        const label = (btn.getAttribute("aria-label") || btn.title || "").toLowerCase();
        return label === "notes" || label.includes("add note");
      }) ||
      null
    );
  }

  function getNotesToolbarAnchor(scope, panel) {
    const notesBtn = findNotesButton(scope);
    if (!notesBtn || isInPanelHeader(notesBtn, panel)) return null;

    const wrapper = notesBtn.parentElement;
    const bar = wrapper?.parentElement;
    if (!bar) return null;

    return { el: bar, insertBefore: wrapper || notesBtn };
  }

  // PolyTranslate's own button ends up on opposite sides of PolyPin
  // depending on view — full-page and drawer anchor to different native
  // elements (header icon cluster vs. notes toolbar), and the two
  // extensions' independent injection order isn't coordinated, so it's
  // essentially coincidental which one lands first in either. When
  // PolyTranslate is installed and its button is present, anchor
  // immediately after it instead, so the relative order is the same in
  // both views — falls back to the existing anchors when it isn't there.
  function findPolyTranslateAnchor(panel) {
    const ptSplit = panel?.querySelector(".pt-translate-split");
    if (!ptSplit?.parentElement) return null;
    return { el: ptSplit.parentElement, insertBefore: ptSplit };
  }

  function findPipButtonAnchor(panel) {
    return (
      findPolyTranslateAnchor(panel) ||
      findConversationHeaderAnchor(panel) ||
      getNotesToolbarAnchor(panel, panel)
    );
  }

  function isButtonWellPlaced(btn, panel) {
    if (!btn.isConnected || !isVisible(btn)) return false;
    if (panel && !panel.contains(btn)) return false;

    // Confirmed live: this needs re-checking on every call, not just once.
    // Our button can land via the header-cluster/notes-toolbar fallback
    // *before* PolyTranslate's own script has rendered its button yet —
    // the two extensions' injection order isn't coordinated — and without
    // this explicit check, the broader containment check below would call
    // it "already fine" forever, so it never gets moved once
    // PolyTranslate's button shows up afterward. When PolyTranslate is
    // present, position is pinned strictly relative to it.
    const ptSplit = panel?.querySelector(".pt-translate-split");
    if (ptSplit) return ptSplit.previousElementSibling === btn;

    const headerIconCluster = getConversationHeaderIconCluster(panel);
    if (headerIconCluster?.contains(btn)) return true;

    const notesBtn = findNotesButton(panel);
    const notesToolbar = notesBtn?.parentElement?.parentElement;
    if (notesToolbar?.contains(btn)) return true;

    return false;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Section: Transcript scraping
  //
  // Selector stack reused verbatim from PolyTranslate's
  // findTurnMessageEls/isNonMessageText/isAgentCallerUtteranceButton — but
  // confirmed live that it must be scoped per utterance button, not per
  // whole [data-turn-idx] container (the container also holds a debug/flow
  // panel — Logs, Request, function names — that leaks into the text
  // otherwise).
  // ──────────────────────────────────────────────────────────────────────

  function isNonMessageText(text) {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (/^(agent|caller|user|assistant)$/i.test(trimmed)) return true;
    if (/^[\w]+_function$/.test(trimmed) || /^fx\s/.test(trimmed)) return true;
    if (/^Caller ID:/i.test(trimmed)) return true;
    if (/^Set skill /i.test(trimmed)) return true;
    if (/^Request \d+$/i.test(trimmed)) return true;
    if (/^Matched topic/i.test(trimmed)) return true;
    return false;
  }

  function isAgentCallerUtteranceButton(btn) {
    if (!btn) return false;
    const testId = btn.getAttribute("data-test-id") || "";
    if (testId.startsWith("function-call-")) return false;

    const hasLabel = [...btn.querySelectorAll("p, span")].some((el) =>
      /^(agent|caller)$/i.test(el.textContent.trim())
    );
    if (hasLabel) return true;

    return Boolean(btn.closest('[data-test-id^="turn-idx-"]'));
  }

  // Scoped to a single utterance button, not the whole turn container.
  function findTurnMessageEls(scope) {
    const selectors = [
      "[data-test-id='chat-message-text']",
      "[class*='MessageText']",
      "[class*='message-text']",
      "[class*='turn-text']",
      "span.whitespace-pre-wrap",
      "span[class*='text-body-regular']",
    ];
    const candidates = [];
    const seen = new Set();

    for (const sel of selectors) {
      for (const el of scope.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        candidates.push(el);
      }
    }

    const valid = candidates.filter((el) => !isNonMessageText(el.textContent));
    return valid.filter((el) => !valid.some((other) => other !== el && el.contains(other)));
  }

  // PolyTranslate interop (free, optional, one-way read — see DESIGN_SPEC.md
  // "Reusable Infrastructure"). When PolyTranslate has translated a turn it
  // wraps it: span.pt-translated > span.pt-turn-translation > either
  // (.pt-turn-original + .pt-turn-translated) or (.pt-turn-primary +
  // .pt-turn-note for the "no translation needed" case). Prefer whatever
  // Studio is currently *displaying*; fall back to plain text when
  // PolyTranslate isn't installed/active.
  function getDisplayText(el) {
    if (el.classList.contains("pt-translated")) {
      const translated = el.querySelector(".pt-turn-translated");
      if (translated) {
        return { text: translated.textContent.trim(), original: el.querySelector(".pt-turn-original")?.textContent.trim() || null };
      }
      const primary = el.querySelector(".pt-turn-primary");
      if (primary) return { text: primary.textContent.trim(), original: null };
    }
    return { text: el.textContent.trim(), original: null };
  }

  // Mirrors whichever of Studio's own "Debug options" (gear icon next to
  // the pin/translate buttons — Variables, Flows and steps, Tool calls,
  // LLM Request, Topic citations, Sources, Transcript corrections, Turn
  // latency, Interruptions, Variants, Logs, Guardrails) are currently
  // checked, live, with no per-type wiring of our own. Confirmed live:
  // unchecking one of those boxes removes its element(s) from the DOM
  // outright (e.g. unchecking "Logs" makes the whole Logs card vanish) —
  // a real childList mutation, not a CSS/attribute hide — so "whatever
  // extra debug content is currently in the turn already reflects the
  // live toggle state for free, and the existing page-wide
  // MutationObserver (already driving maybeRefreshPipForContentChange)
  // picks it up without any new polling or checkbox-reading.
  //
  // v1 of this walked turnEl.innerText and diffed it line-by-line against
  // each button's message text, treating every leftover *line* as its
  // own chip. Two problems, both confirmed live against a real
  // PolyTranslate-active conversation:
  //   - The line-diff matched wanted lines by their raw textContent, but
  //     a PolyTranslate-wrapped message's raw textContent jams the
  //     translated + original text together into one string that never
  //     equals any single innerText line (Studio renders them as two
  //     separate visual lines) — so both leaked out as debug chips.
  //   - Studio itself groups related content (a name + duration, a label
  //     + its chip values) as one visual unit that just happens to
  //     *render* as multiple text lines/inline chips — line-splitting
  //     destroyed that grouping ("Sources:" and "No matches" became two
  //     separate chips instead of one).
  // Fixed by walking the actual DOM structure instead of its rendered
  // text, excluding by *element identity* (immune to the textContent
  // mismatch above) and recognizing known container shapes so each one
  // becomes a single, sensibly-labeled entry:
  //   - `[data-test-id="flow-entered-tag"/"flow-exited-tag"/
  //     "step-transition-tag"]` → one "flow" entry ("Entered General
  //     Line Disambig").
  //   - `[data-test-id="accordion__item-header"]` — Studio's one shared
  //     collapsible-row component, used for start_function, "Request"
  //     tool-call boxes, *and* Logs — → one "card" entry. Logs is
  //     flagged specially: confirmed live that expanding it mounts real
  //     content (individual log-entry headers, e.g. "Claremedica API
  //     patient lookup succeeded" — already meaningful on their own, and
  //     themselves recursively expandable, see buildLogsCardEntry) as a
  //     sibling body under the same parent, and that a plain `.click()`
  //     on the header toggles it — same "remote-control the real thing"
  //     approach as audio play/pause. The PiP mirrors that toggle by
  //     re-locating the live header at click time (findAccordionHeaderByPath)
  //     rather than clicking a reference captured back at scrape time —
  //     see buildLogsCardEntry for why that distinction matters.
  //   - A chip-group container (Matched topics / Sources — no stable
  //     test-id; identified by Studio's own `flex-wrap items-baseline`
  //     chip styling, confirmed live to uniquely mark exactly this kind
  //     of label+chips block and nothing else in a turn) → one
  //     "chipgroup" entry ("Matched topics: WISMR, OFFICE_WEBSITE, …").
  //   - Anything else (turn-latency badges, and a safety net for any
  //     future debug type not recognized above) → a plain "text" entry.
  // `__utterance__` marker entries record where each utterance button
  // sat in the walk order, purely so splitDebugEntriesByUtterance can
  // divide the flat list back into per-gap segments.
  function collectOwnTextParts(el) {
    const parts = [];
    (function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) parts.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      for (const child of node.childNodes) walk(child);
    })(el);
    return parts;
  }

  function isChipGroupContainer(el) {
    return Boolean(el.classList?.contains("flex-wrap") && el.classList.contains("items-baseline"));
  }

  function buildSimpleCardEntry(headerEl) {
    return { kind: "card", label: collectOwnTextParts(headerEl).join(" "), isLogs: false, subitems: [], bodyText: null };
  }

  // Logs gets recursive treatment the other card types don't: confirmed
  // live that each individual log-entry header (e.g. "LANGUAGE") is
  // *itself* another one of Studio's expandable rows, not a dead label —
  // clicking it reveals a real detail payload (a JSON blob, in every case
  // checked). Reuses the exact same [header, body-as-sibling] shape as
  // the outer Logs card (`headerEl.parentElement.children[1]`), so this
  // one function recurses to whatever depth Studio actually nests to,
  // rather than hard-coding "one level of subitems" — confirmed live to
  // bottom out at plain JSON (no further nested headers) for every entry
  // checked, at which point `bodyText` captures that JSON directly so the
  // PiP can show it without a second remote-click round-trip.
  //
  // Deliberately does NOT close over `headerEl` for later clicking (an
  // earlier version did — `toggleInSource: () => headerEl.click()`).
  // Reported live: clicking a Logs dropdown in the PiP for a turn that
  // hadn't been scrolled into view *on the source page* did nothing, and
  // even after scrolling it into view there, the click expanded it on the
  // source page but the PiP itself never updated. Root cause matches the
  // exact class of bug already documented for the audio-time node
  // elsewhere in this file: Studio's transcript can re-render a turn's
  // subtree with fresh elements once it's actually mounted/settled
  // (distinct from the surrounding `[data-turn-idx]` container, which
  // stays a stable reference), silently orphaning any DOM reference
  // captured before that happened. `headerEl` is still used to build
  // *this* scrape's data (labels, subitems, bodyText all read from it
  // right now, synchronously, which is safe), but the *turnIdx + label
  // path* is what gets stored for clicking later — see
  // findAccordionHeaderByPath, which re-locates the live node fresh at
  // click time instead of trusting a captured one to still be valid.
  function buildLogsCardEntry(headerEl, turnIdx, parentPath) {
    const label = collectOwnTextParts(headerEl).join(" ");
    const path = [...parentPath, label];
    const cardWrapper = headerEl.parentElement;
    const body = cardWrapper && cardWrapper.children[1];
    let subitems = [];
    let bodyText = null;

    if (body) {
      // Deliberately scoped to `body`'s direct children (each entry's own
      // wrapper div), not a flat `body.querySelectorAll(...)` — the latter
      // would also catch a *grandchild* header from a deeper level and
      // misfile it as a direct sibling, flattening the hierarchy instead
      // of preserving it.
      const childHeaders = [...body.children]
        .map((wrapper) => wrapper.querySelector('[data-test-id="accordion__item-header"]'))
        .filter(Boolean);
      if (childHeaders.length > 0) {
        subitems = childHeaders.map((h) => buildLogsCardEntry(h, turnIdx, path));
      } else {
        bodyText = body.innerText.trim() || null;
      }
    }

    return { kind: "card", label, isLogs: true, subitems, bodyText, turnIdx, path };
  }

  // Re-locates a specific Logs (sub)entry's header fresh, by walking down
  // from the turn's top-level Logs card through `path` matching each
  // nested header's *current* label text — never a captured reference —
  // so a click always operates on whatever's actually live right now. See
  // buildLogsCardEntry above for why this exists. `path[0]` is always
  // "Logs" itself; loop starts at index 1 to skip re-matching the root.
  // Known limitation, accepted: if two sibling log entries under the same
  // parent ever share the exact same label text, this matches whichever
  // comes first — no stronger identity than label text is available.
  function findAccordionHeaderByPath(panel, turnIdx, path) {
    const scope = panel || document;
    const turnEl = scope.querySelector(`[data-turn-idx="${turnIdx}"]`);
    if (!turnEl) return null;

    let header = turnEl.querySelector('[data-test-id="logs-card-header"]')?.closest('[data-test-id="accordion__item-header"]');
    for (let i = 1; i < path.length && header; i++) {
      const body = header.parentElement && header.parentElement.children[1];
      if (!body) return null; // not expanded on the source page (yet) — nothing live to click into

      const nextHeader = [...body.children]
        .map((wrapper) => wrapper.querySelector('[data-test-id="accordion__item-header"]'))
        .filter(Boolean)
        .find((h) => collectOwnTextParts(h).join(" ") === path[i]);
      if (!nextHeader) return null;
      header = nextHeader;
    }
    return header || null;
  }

  // Reported live, three times now, each fix uncovering the next layer:
  //   1. findAccordionHeaderByPath's fresh re-lookup (not a captured
  //      reference — see buildLogsCardEntry) fixed clicking a *stale*
  //      node, but clicking a Logs dropdown in the PiP still did nothing
  //      when the source page hadn't been scrolled to that turn.
  //   2. Root cause of *that*: the header exists in the DOM regardless
  //      of scroll position, but isn't reliably *interactive* until the
  //      turn has actually been scrolled into view (some further
  //      Studio-side activation gated on real viewport visibility, not
  //      mounting) — so scrolling has to happen unconditionally, and the
  //      click has to be retried afterward, not just the lookup.
  //   3. That fix (scroll once, then re-click every 150ms until a body
  //      sibling shows up) *did* expand it on the source page — but the
  //      PiP still didn't update, and a second click in the PiP couldn't
  //      close it again. Root cause of *that*, found live: two bugs.
  //      First, re-clicking every 150ms with no floor is fast enough to
  //      land a second click on Studio's own accordion while the first
  //      click's expand is still settling (a transition, or a data
  //      fetch for the log body) — which registers as a *third* toggle,
  //      not a confirmation, and can flip it straight back closed before
  //      our own check ever sees it open. Second, and more direct: the
  //      PiP's click handler decided expand-vs-collapse from `hasContent`
  //      — computed once, at the *last render* — so once the source page
  //      changed state without the PiP re-rendering yet (exactly what
  //      bug one caused), every further click kept reading that stale
  //      "still collapsed" flag and kept calling *expand*, which
  //      correctly no-ops when it finds the thing already open — so a
  //      click meant to close it did nothing, every time.
  //
  // Fixed by, respectively: spacing retries out to a real settle delay
  // after each click rather than a tight fixed interval (see
  // SETTLE_AFTER_CLICK_MS below), and by having the click handler
  // determine expand-vs-collapse from a *fresh* look at the source page
  // right at click time (toggleAccordionHeaderByPath) instead of
  // whatever the PiP happened to last render.
  function expandAccordionHeaderByPath(panel, turnIdx, path, attempt = 0) {
    const MAX_ATTEMPTS = 10;
    // Deliberately longer than the 150ms used elsewhere in this file for
    // polling *existence* (e.g. waitForConversationSwap) — this isn't
    // waiting to notice a change that already happened, it's waiting for
    // Studio's own expand (transition and/or data fetch) to actually
    // finish before deciding whether the click needs retrying at all.
    // Confirmed live that 150ms was too tight for that and could cause a
    // second click to land mid-transition, toggling it back closed.
    const SETTLE_AFTER_CLICK_MS = 700;

    if (attempt === 0) {
      (panel || document).querySelector(`[data-turn-idx="${turnIdx}"]`)?.scrollIntoView({ block: "center" });
    }

    const header = findAccordionHeaderByPath(panel, turnIdx, path);
    if (!header) {
      // Not mounted/found yet at all — keep checking at a brisk interval;
      // nothing to click yet, so there's no over-click risk here.
      if (attempt >= MAX_ATTEMPTS) return;
      setTimeout(() => expandAccordionHeaderByPath(panel, turnIdx, path, attempt + 1), 150);
      return;
    }

    const alreadyExpanded = Boolean(header.parentElement && header.parentElement.children[1]);
    if (alreadyExpanded) return; // done

    header.click();
    if (attempt >= MAX_ATTEMPTS) return; // give up quietly after several real settle windows
    setTimeout(() => expandAccordionHeaderByPath(panel, turnIdx, path, attempt + 1), SETTLE_AFTER_CLICK_MS);
  }

  // Collapsing has none of the above problems — an already-expanded card
  // is, by definition, already fully live and interactive on the source
  // page (nothing further needed to make it so), so a single fresh
  // find-and-click is enough. Kept separate from expandAccordionHeaderByPath
  // rather than folding a "which direction" flag into one function,
  // since the two have genuinely different reliability requirements.
  function collapseAccordionHeaderByPath(panel, turnIdx, path) {
    findAccordionHeaderByPath(panel, turnIdx, path)?.click();
  }

  // The single entry point the PiP's Logs button should call — decides
  // expand vs. collapse from the *live* source page at the moment of the
  // click, not from whatever the PiP last happened to render (see the
  // long comment above expandAccordionHeaderByPath for why that
  // distinction is exactly what bug 3 there was). This is what makes a
  // second click correctly close something the first click just opened,
  // even if the PiP itself hasn't re-rendered yet to reflect that.
  function toggleAccordionHeaderByPath(panel, turnIdx, path) {
    const header = findAccordionHeaderByPath(panel, turnIdx, path);
    const alreadyExpanded = Boolean(header && header.parentElement && header.parentElement.children[1]);
    if (alreadyExpanded) {
      header.click();
    } else {
      expandAccordionHeaderByPath(panel, turnIdx, path);
    }
  }

  function collectTurnDebugEntries(turnEl, buttons, excludedEls) {
    const entries = [];
    const buttonIndex = new Map(buttons.map((b, i) => [b, i]));
    // A card's body (nested log-entry headers, once expanded — see the
    // accordion__item-header branch below) is a *sibling* of its header,
    // not a descendant, so the outer walk would otherwise reach it again
    // on its own and re-emit every nested header a second time as if it
    // were a fresh top-level card. Confirmed live. Tracking consumed
    // bodies here is what keeps each one a one-shot read.
    const handledBodies = new Set();

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.replace(/\s+/g, " ").trim();
        if (text) entries.push({ kind: "text", text });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (excludedEls.has(node)) return; // the message or speaker-label element — skip it and its children entirely
      if (handledBodies.has(node)) return;

      if (buttonIndex.has(node)) {
        entries.push({ kind: "__utterance__", index: buttonIndex.get(node) });
        for (const child of node.childNodes) walk(child); // still descend — latency/topics/sources live inside
        return;
      }

      const testId = node.getAttribute("data-test-id");
      if (testId === "flow-entered-tag" || testId === "flow-exited-tag" || testId === "step-transition-tag") {
        const text = collectOwnTextParts(node).join(" ");
        if (text) entries.push({ kind: "flow", text });
        return;
      }
      if (testId === "accordion__item-header") {
        const isLogs = Boolean(node.querySelector('[data-test-id="logs-card-header"]'));
        const entry = isLogs
          ? buildLogsCardEntry(node, turnEl.getAttribute("data-turn-idx"), [])
          : buildSimpleCardEntry(node);
        // The card's body (nested content, when expanded) is a sibling
        // of the header under the same parent — confirmed live. Consumed
        // above (recursively, for Logs) via the same node reference.
        const body = node.parentElement && node.parentElement.children[1];
        if (body) handledBodies.add(body);
        if (entry.label) entries.push(entry);
        return;
      }
      if (isChipGroupContainer(node)) {
        const parts = collectOwnTextParts(node);
        if (parts.length > 0) {
          const [label, ...values] = parts;
          entries.push({ kind: "chipgroup", label, values });
        }
        return;
      }

      for (const child of node.childNodes) walk(child);
    }

    walk(turnEl);
    return entries;
  }

  // Two cleanups the structural walk above can't do in one pass, applied
  // to its flat output afterward:
  //   - A flow-step/tool-call's duration ("2.223s", "545ms") is confirmed
  //     live to *not* be a descendant of its accordion__item-header —
  //     it's rendered by a separate hover/tooltip element elsewhere in
  //     the turn, landing in the walk immediately after its card as a
  //     lone "text" entry. Reattach it to that card's label rather than
  //     leaving it as its own stray chip.
  //   - Some plain badges (the turn-latency line, e.g. "User perceived
  //     latency: 0.121s") render their label, number, and unit as three
  //     separate sibling text nodes with no recognized container at
  //     all — confirmed live. Glue consecutive plain "text" entries back
  //     into one, joining a bare unit suffix ("s"/"ms"/"m"/"h") directly
  //     onto the previous fragment with no space so "0.121" + "s" reads
  //     as "0.121s", not "0.121 s".
  function postProcessDebugEntries(entries) {
    const unitRe = /^(ms|s|m|h)$/;
    const durationRe = /^\d+(\.\d+)?(ms|s)$/;
    const merged = [];
    for (const entry of entries) {
      const prev = merged[merged.length - 1];
      if (entry.kind === "text" && prev?.kind === "text") {
        prev.text = unitRe.test(entry.text) ? `${prev.text}${entry.text}` : `${prev.text} ${entry.text}`;
        continue;
      }
      if (entry.kind === "text" && durationRe.test(entry.text) && prev?.kind === "card" && !prev.isLogs) {
        prev.label = `${prev.label} · ${entry.text}`;
        continue;
      }
      merged.push({ ...entry });
    }
    return merged;
  }

  // Splits collectTurnDebugEntries' flat, marker-interleaved list back
  // into one array per gap — before the first button, between each pair,
  // and after the last — for the caller to attach to the turn objects on
  // either side.
  function splitDebugEntriesByUtterance(entries, buttonCount) {
    const segments = Array.from({ length: buttonCount + 1 }, () => []);
    let seg = 0;
    for (const entry of entries) {
      if (entry.kind === "__utterance__") {
        seg = entry.index + 1;
        continue;
      }
      segments[seg].push(entry);
    }
    return segments;
  }

  // Speaker attribution is NOT one-label-per-turn-idx (confirmed live —
  // see DESIGN_SPEC.md). Only the very first utterance bubble in the whole
  // conversation carries an explicit label; every bubble after that is
  // unlabeled and speaker strictly alternates. Track it across the whole
  // scrape, resyncing to an explicit label if one ever reappears.
  function scrapeConversation(panel) {
    const turnEls = [...panel.querySelectorAll("[data-turn-idx]")].filter(isVisible);
    const turns = [];
    let currentSpeaker = null;
    // Debug entries (see collectTurnDebugEntries) that haven't been
    // attached to a turn object yet — carries forward across turn-idx
    // boundaries and across buttons that turned out to have no message
    // (skipped below), so nothing gets silently dropped.
    let pendingDebug = [];

    for (const turnEl of turnEls) {
      const buttons = [...turnEl.querySelectorAll("button.select-text, button[data-dd-privacy='mask']")].filter(
        isAgentCallerUtteranceButton
      );

      if (buttons.length === 0) {
        // A turn-idx with no utterance at all — rare, but its content is
        // then entirely debug/meta. Carry it forward rather than
        // dropping it.
        pendingDebug.push(
          ...turnEl.innerText
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((text) => ({ kind: "text", text }))
        );
        continue;
      }

      // Computed once per button and reused for both the exclusion set
      // below and the message-text construction further down, so the
      // two can never drift out of sync on what counts as "the message".
      const buttonInfos = buttons.map((btn) => {
        const labelEl = [...btn.querySelectorAll("p, span")].find((e) => /^(agent|caller)$/i.test(e.textContent.trim()));
        return { btn, labelEl, label: labelEl ? labelEl.textContent.trim() : null, msgEls: findTurnMessageEls(btn) };
      });

      const excludedEls = new Set();
      buttonInfos.forEach(({ labelEl, msgEls }) => {
        if (labelEl) excludedEls.add(labelEl);
        msgEls.forEach((el) => excludedEls.add(el));
      });

      const entries = postProcessDebugEntries(collectTurnDebugEntries(turnEl, buttons, excludedEls));
      const debugSegments = splitDebugEntriesByUtterance(entries, buttons.length);

      buttonInfos.forEach(({ label, msgEls }, i) => {
        if (label) {
          currentSpeaker = label;
        } else if (currentSpeaker) {
          currentSpeaker = currentSpeaker.toLowerCase() === "agent" ? "Caller" : "Agent";
        } else {
          currentSpeaker = "Agent"; // first bubble ever, no label seen — best-effort default
        }

        const debugBefore = pendingDebug.concat(debugSegments[i]);
        pendingDebug = [];

        if (msgEls.length === 0) {
          pendingDebug = debugBefore; // nothing to attach this to yet — keep carrying it
          return;
        }

        const combined = msgEls.map(getDisplayText);
        const text = combined.map((c) => c.text).filter(Boolean).join(" ");
        const original = combined.map((c) => c.original).filter(Boolean).join(" ") || null;
        if (!text) {
          pendingDebug = debugBefore;
          return;
        }

        turns.push({
          speaker: currentSpeaker,
          text,
          original,
          turnIdx: turnEl.getAttribute("data-turn-idx"),
          debugBefore,
        });
      });

      pendingDebug.push(...debugSegments[buttons.length]); // trailing entries after this turn-idx's last button
    }

    const title = document.title.replace(/^PolyAI Agent Studio\s*-\s*/, "").trim();
    const sid = getCurrentCallSid();

    // hasAudio ("is this the kind of conversation that has a player at
    // all") is deliberately separate from audioReady ("is that player
    // actually usable right now"). Collapsing them into one flag was the
    // bug: hasAudio used to be just Boolean(getAudioPlayBtn(panel)), true
    // the instant the button *mounts* — see isAudioReady for why that's
    // not the same as ready, and why treating "button exists" as "ready"
    // let a half-loaded state (stale duration, no waveform) render as if
    // it were final.
    const hasAudio = isVoiceCallSid(sid);
    const audioReady = hasAudio && isAudioReady(panel);

    return {
      sid,
      title: title || "Conversation",
      turns,
      trailingDebug: pendingDebug, // leftover debug lines after the very last utterance
      hasAudio,
      audioReady,
      waveforms: audioReady ? captureWaveformImages(panel) : [],
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Section: Audio remote-control
  //
  // Correction from earlier testing (see DESIGN_SPEC.md): a real <audio>
  // element *does* exist — three of them, in fact — but hidden behind open
  // shadow roots that a plain document.querySelectorAll('audio') never
  // pierces, which is why the original investigation missed them. Doesn't
  // change the remote-control approach though: driving them directly
  // (e.g. .currentTime) doesn't actually move Studio's own playback/UI, so
  // play/pause and position still go through the same stable,
  // shadow-DOM-independent surface:
  //   - [data-test-id="audio-play-btn"] — aria-label flips Play/Pause
  //   - [data-test-id="audio-time"]     — text node "MM:SS / MM:SS"
  // What the shadow roots *do* unlock: each contains a <canvas> rendering
  // the actual waveform Studio draws — capturing it via .toDataURL() (not
  // tainted, confirmed) gives a pixel-perfect real waveform for the PiP,
  // see captureWaveformImages() below.
  // Not every conversation has a player at all (chat/webchat SIDs) —
  // callers must feature-detect before wiring anything.
  // ──────────────────────────────────────────────────────────────────────

  function getAudioPlayBtn(panel) {
    const scope = panel || document;
    return scope.querySelector('[data-test-id="audio-play-btn"]') || document.querySelector('[data-test-id="audio-play-btn"]');
  }

  function getAudioTimeEl(panel) {
    const scope = panel || document;
    return scope.querySelector('[data-test-id="audio-time"]') || document.querySelector('[data-test-id="audio-time"]');
  }

  function parseAudioTime(text) {
    const match = (text || "").match(/(\d{1,2}):(\d{2})\s*\/\s*(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const [, cm, cs, dm, ds] = match;
    return {
      currentSeconds: Number(cm) * 60 + Number(cs),
      durationSeconds: Number(dm) * 60 + Number(ds),
    };
  }

  function isAudioPlaying(panel) {
    const btn = getAudioPlayBtn(panel);
    return (btn?.getAttribute("aria-label") || "").toLowerCase() === "pause";
  }

  // Finds each per-speaker waveform track: an element with an open shadow
  // root containing a <canvas> (the actual rendered waveform), labeled by
  // walking up to the nearest "Assistant"/"Caller" text in the same row.
  // Confirmed live: two such hosts exist per call (one per speaker), each
  // with up to two stacked canvases (background + played-progress overlay
  // in wavesurfer-style setups) — composite whatever's there rather than
  // assuming which one is "the" canvas, so the capture matches what's
  // actually visible regardless of layering.
  function getWaveformTracks(panel) {
    const scope = panel || document;
    const hosts = [];
    (function walk(root) {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          if (el.shadowRoot.querySelector("canvas")) hosts.push(el);
          walk(el.shadowRoot);
        }
      }
    })(scope);

    return hosts.map((host) => {
      let label = null;
      let node = host;
      for (let i = 0; i < 6 && node && !label; i++) {
        const labelEl = [...(node.parentElement?.querySelectorAll("span, p, div") || [])].find(
          (el) => el.children.length === 0 && /^(agent|caller|assistant)$/i.test(el.textContent.trim())
        );
        if (labelEl) label = labelEl.textContent.trim();
        node = node.parentElement;
      }
      return { host, label: label || "Track", canvases: [...host.shadowRoot.querySelectorAll("canvas")] };
    });
  }

  // A canvas gets its width/height set as soon as it's created — well
  // before whatever library owns it actually paints the waveform shape
  // onto it. Confirmed live: gating readiness on size alone let through a
  // real-but-blank canvas, which produced a technically-valid PNG capture
  // (so the "empty → fallback bar" path never triggered) that just showed
  // nothing. This checks the actual pixels: samples the alpha channel
  // sparsely (a real waveform has bars of full opacity against a gapped
  // background, so alpha varies once something's actually drawn; a blank
  // canvas is uniform) rather than trusting the element's dimensions.
  // Cache of canvases already confirmed to have real content — once a
  // waveform is painted it doesn't go blank again for that element's
  // lifetime, but this check runs on every mutation-observer tick and nav
  // poll (readiness gets re-checked constantly while loading), so without
  // caching we'd re-run a full getImageData readback on the same
  // already-known-ready canvas indefinitely. Chrome flags exactly this
  // pattern: "Multiple readback operations using getImageData are faster
  // with willReadFrequently set to true." Caching avoids re-reading
  // Studio's own canvases at all past the first confirmation (we can't set
  // willReadFrequently on those — their context was already created by
  // Studio's own code before we ever touch them); willReadFrequently below
  // covers the canvases we create ourselves.
  const canvasesConfirmedReady = new WeakSet();

  function canvasHasRealContent(canvas) {
    if (canvasesConfirmedReady.has(canvas)) return true;
    if (!canvas.width || !canvas.height) return false;
    try {
      const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      let min = 255;
      let max = 0;
      for (let i = 3; i < data.length; i += 4 * 37) {
        const alpha = data[i];
        if (alpha < min) min = alpha;
        if (alpha > max) max = alpha;
        if (max - min > 10) {
          canvasesConfirmedReady.add(canvas);
          return true;
        }
      }
      return false;
    } catch {
      return false; // tainted or inaccessible — treat as not-ready, not an error
    }
  }

  // Captures the real waveform pixels Studio itself drew, once per PiP
  // open/refresh (the shape is static for the whole call — only the
  // playhead position, drawn separately by the PiP, changes over time).
  function captureWaveformImages(panel) {
    return getWaveformTracks(panel)
      .map((track) => {
        if (track.canvases.length === 0) return null;
        try {
          const { width, height } = track.canvases[0];
          if (!width || !height) return null;
          const composite = document.createElement("canvas");
          composite.width = width;
          composite.height = height;
          // willReadFrequently: true — this canvas exists purely so we can
          // immediately read it back via canvasHasRealContent/toDataURL,
          // never to display it directly, so opting into the CPU-backed
          // canvas Chrome recommends for repeated readback is a clean win
          // here (unlike Studio's own canvases, whose context we don't
          // control and can't retroactively set this on).
          const ctx = composite.getContext("2d", { willReadFrequently: true });
          track.canvases.forEach((c) => ctx.drawImage(c, 0, 0));
          if (!canvasHasRealContent(composite)) return null;
          return { label: track.label, dataUrl: composite.toDataURL("image/png") };
        } catch (err) {
          console.warn("[PolyPin] Waveform capture failed for a track:", err);
          return null;
        }
      })
      .filter(Boolean);
  }

  // Shared by isConversationReady (gates the trigger button and PiP
  // open/update) and scrapeConversation (decides whether to render the
  // audio bar as working vs. loading) — kept as one function so the two
  // can't drift out of sync on what "ready" actually means. Confirmed
  // live: Studio's play button mounts with its data-test-id present well
  // before it's usable — it stays a real, native `disabled` button (also
  // aria-disabled="true") for as long as its own "loading audio" state
  // lasts, sometimes many seconds, and its time text can still show the
  // *previous* conversation's stale duration during that window. Checking
  // existence alone isn't enough; disabled is the direct, authoritative
  // signal Studio itself uses for "can this actually be clicked yet," and
  // canvasHasRealContent (not just non-zero canvas dimensions) confirms
  // the waveform itself has actually been painted.
  function isAudioReady(panel) {
    const playBtn = getAudioPlayBtn(panel);
    if (!playBtn || playBtn.disabled) return false;
    return getWaveformTracks(panel).some((track) => track.canvases.some(canvasHasRealContent));
  }

  // Gates every PiP open/update on this, rather than opening with whatever
  // happens to exist yet and patching it up afterward. Confirmed live: the
  // audio player (and its waveform canvases) mounts asynchronously, after
  // the transcript turns are already visible — clicking the trigger button
  // in that window used to open a PiP whose play button silently did
  // nothing, because wireAudioRemoteControl found no
  // [data-test-id="audio-play-btn"] to attach to and just skipped audio
  // entirely for that PiP's lifetime (a re-render doesn't rewire it later).
  // Chat/webchat conversations have no player at all, ever, and are ready
  // as soon as their turns exist — voice calls additionally need isAudioReady.
  function isConversationReady(panel) {
    const sid = getCurrentCallSid();
    if (!sid || !getFirstTurn(panel)) return false;
    if (!isVoiceCallSid(sid)) return true;
    return isAudioReady(panel);
  }

  // Builds a small remote-control handle bound to a specific source panel.
  //
  // `onTick` polls rather than observes: an earlier version attached a
  // MutationObserver to the [data-test-id="audio-time"] node once and
  // watched it for characterData/childList changes, but confirmed live
  // that Studio's React re-renders replace that node outright during
  // active playback (not just mutate its text) — the observer goes stale
  // and stops firing, while the play/pause button's own click handler kept
  // working because it always re-queries the DOM fresh via currentState().
  // Polling sidesteps node staleness entirely by re-querying every tick.
  //
  // The raw poll alone paints as a visible "chunky" jump every ~400ms, so
  // onTick also dead-reckons a smooth position between samples: extrapolate
  // forward from the last real sample using elapsed wall-clock time,
  // re-baselined only when a poll disagrees with that estimate by more than
  // the ~1s noise floor (see sample(), below, for why *every* poll can't
  // trigger a resync). The animation driving that has to run on the *PiP
  // window's* requestAnimationFrame, not the source tab's — the source tab
  // is allowed to be backgrounded by design, and Chrome throttles rAF in
  // backgrounded tabs, which would make the motion worse, not smoother.
  // Hence `win` is required here.
  function createAudioRemote(panel, win) {
    let tickCallback = null;
    let intervalHandle = null;
    let rafHandle = null;
    let lastSample = { seconds: 0, atMs: 0, isPlaying: false, durationSeconds: 0 };

    function currentState() {
      const timeEl = getAudioTimeEl(panel);
      const parsed = parseAudioTime(timeEl?.textContent);
      return {
        isPlaying: isAudioPlaying(panel),
        currentSeconds: parsed?.currentSeconds ?? 0,
        durationSeconds: parsed?.durationSeconds ?? 0,
      };
    }

    function togglePlayPause() {
      getAudioPlayBtn(panel)?.click();
    }

    function estimatedSeconds() {
      if (!lastSample.isPlaying) return lastSample.seconds;
      const elapsed = (win.performance.now() - lastSample.atMs) / 1000;
      return Math.min(lastSample.durationSeconds, lastSample.seconds + elapsed);
    }

    function frame() {
      tickCallback?.({
        isPlaying: lastSample.isPlaying,
        currentSeconds: estimatedSeconds(),
        durationSeconds: lastSample.durationSeconds,
      });
      rafHandle = lastSample.isPlaying ? win.requestAnimationFrame(frame) : null;
    }

    // Only re-baseline the extrapolation when there's a *meaningful*
    // discrepancy — a real seek, a fresh sample, or a play/pause toggle —
    // not on every poll. Studio's own displayed time is whole-second
    // granularity, so most 400ms polls read back the exact same second our
    // own estimate is already mid-way through; naively resetting the
    // baseline to that value every time snapped the estimate backward to
    // the start of that second and made it re-ramp forward on repeat — a
    // sawtooth, not smooth motion (confirmed live: this was the actual
    // cause of the reported "skipping around" jitter).
    function sample(state) {
      const now = win.performance.now();
      const isFirstSample = lastSample.durationSeconds === 0;
      const drift = Math.abs(state.currentSeconds - estimatedSeconds());
      const shouldResync = isFirstSample || state.isPlaying !== lastSample.isPlaying || drift > 1.05;

      lastSample = shouldResync
        ? { seconds: state.currentSeconds, atMs: now, isPlaying: state.isPlaying, durationSeconds: state.durationSeconds }
        : { ...lastSample, isPlaying: state.isPlaying, durationSeconds: state.durationSeconds };

      if (state.isPlaying && rafHandle === null) {
        rafHandle = win.requestAnimationFrame(frame);
      } else if (!state.isPlaying) {
        if (rafHandle !== null) win.cancelAnimationFrame(rafHandle);
        rafHandle = null;
        frame(); // one final paint at the exact paused position
      }
    }

    function onTick(cb) {
      tickCallback = cb;
      sample(currentState()); // paint real state immediately, don't wait for the first interval tick
      intervalHandle = setInterval(() => sample(currentState()), 400);
    }

    function destroy() {
      if (intervalHandle) clearInterval(intervalHandle);
      if (rafHandle !== null) win.cancelAnimationFrame(rafHandle);
      intervalHandle = null;
      rafHandle = null;
      tickCallback = null;
    }

    return { currentState, togglePlayPause, onTick, destroy };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Section: PiP window
  // ──────────────────────────────────────────────────────────────────────

  let pipWindow = null;
  let pipAudioRemote = null;
  let pipSourcePanel = null;
  let pipCssText = null;
  let lastRenderedFingerprint = null;

  async function getPipCssText() {
    if (pipCssText) return pipCssText;
    const resp = await fetch(chrome.runtime.getURL("pip.css"));
    pipCssText = await resp.text();
    return pipCssText;
  }

  // Confirmed live against the real app, in both modes: Studio marks its
  // *currently applied* theme with a plain `dark` class on `<html>` —
  // present in dark mode, absent (empty className) in light mode. It
  // also persists the user's chosen preference to
  // `localStorage['polyai.theme']` ("Dark"/"Light"), but the class is the
  // more direct signal — it's the exact thing Studio's own CSS keys off,
  // so reading it can't drift from what's actually rendered the way a
  // separately-stored preference value theoretically could (e.g. if
  // Studio ever added a "System" option that resolves against the OS
  // preference rather than a stored literal).
  function getStudioTheme() {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }

  // Stamps the PiP's own <html> with the source page's current theme —
  // pip.css keys its light-mode overrides off `:root[data-pp-theme=
  // "light"]` (dark is the unmarked default). Deliberately its own
  // pollable step rather than only ever being set once at window
  // creation: the user can toggle Studio's theme at any time while the
  // PiP is already open, with no conversation *content* change at all to
  // otherwise trigger a re-render, and the PiP should follow immediately
  // either way.
  function applyPipTheme(win) {
    if (!win || win.closed) return;
    win.document.documentElement.dataset.ppTheme = getStudioTheme();
  }

  function formatClock(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Mirrors whichever of Studio's own debug/meta annotations are
  // currently visible (see collectTurnDebugEntries) as a row of small
  // muted chips ahead of the turn they preceded on the source page —
  // one chip per grouped entry, not per raw text line, so "Sources:" and
  // "No matches" render together instead of fragmenting. Deliberately
  // not styled like a real message bubble — see .pp-debug-strip in
  // pip.css — this is meta, not conversation content.
  //
  // Flow milestones ("flow" kind — Entered/Exited a flow, step
  // transitions) are the most meaningful signal in the strip at a
  // glance: which flow the conversation is in, and when it moved. They
  // render first, ahead of the more granular debug noise (latency,
  // matched topics, tool calls), regardless of where they fell in the
  // original DOM order, and get their own more prominent chip styling
  // (.pp-debug-chip-flow in pip.css) rather than blending in with
  // everything else.
  function buildDebugStrip(doc, entries) {
    const strip = doc.createElement("div");
    strip.className = "pp-debug-strip";

    const flowEntries = entries.filter((e) => e.kind === "flow");
    const otherEntries = entries.filter((e) => e.kind !== "flow");

    [...flowEntries, ...otherEntries].forEach((entry) => {
      if (entry.kind === "card" && entry.isLogs) {
        strip.appendChild(buildLogsCard(doc, entry));
        return;
      }

      const chip = doc.createElement("span");
      chip.className = entry.kind === "flow" ? "pp-debug-chip pp-debug-chip-flow" : "pp-debug-chip";
      if (entry.kind === "chipgroup") {
        chip.textContent = entry.values.length > 0 ? `${entry.label} ${entry.values.join(", ")}` : entry.label;
      } else if (entry.kind === "card") {
        chip.textContent = entry.label;
      } else {
        chip.textContent = entry.text;
      }
      strip.appendChild(chip);
    });

    return strip;
  }

  // Studio's own "Logs" card is itself a real dropdown, not a flat line —
  // mirror that instead of flattening it to a single chip. If it's
  // already expanded on the source page, its individual log-entry
  // headers (confirmed live to already be meaningful summary text on
  // their own — e.g. "Claremedica API patient lookup succeeded") render
  // directly below. Either way, the header button works: clicking it
  // calls toggleAccordionHeaderByPath, which re-checks the *live* source
  // page (using `pipSourcePanel`, always the current one — not a
  // captured reference) to decide expand vs. collapse, then either
  // clicks straight through (collapse) or scrolls the turn into view and
  // retries the click until it actually takes (expand) — see that
  // function and expandAccordionHeaderByPath's own comments for why both
  // of those were necessary, confirmed live. Same "remote-control the
  // real thing, don't fake it" approach as audio play/pause elsewhere in
  // this file. The next maybeRefreshPipForContentChange poll tick
  // (≤600ms after that succeeds) picks up the resulting DOM change and
  // re-renders this card with the real entries, exactly like a
  // debug-options checkbox toggle does.
  //
  // Recursive, not one level deep: confirmed live that each individual
  // log entry is *itself* another one of these same dropdowns (see
  // buildLogsCardEntry), so this function calls itself for `subitems` —
  // clicking into "LANGUAGE" inside the Logs list works exactly the same
  // way as clicking "Logs" itself did, all the way down to whatever
  // actually bottoms out in a real JSON payload (`bodyText`).
  function buildLogsCard(doc, entry) {
    const card = doc.createElement("div");
    card.className = "pp-debug-logs";

    // hasContent reflects the *last render* — fine for what the chevron
    // shows, but not safe to decide the click's direction from (see the
    // long comment above expandAccordionHeaderByPath: that was exactly
    // bug 3, a stale render-time flag causing a second click to try to
    // re-expand an already-open card instead of closing it).
    // toggleAccordionHeaderByPath re-checks the live source page itself.
    const hasContent = entry.subitems.length > 0 || Boolean(entry.bodyText);
    const header = doc.createElement("button");
    header.type = "button";
    header.className = "pp-debug-logs-header";
    header.textContent = `${hasContent ? "▾" : "▸"} ${entry.label}`;
    header.title = "Toggle on the source page";
    header.onclick = () => toggleAccordionHeaderByPath(pipSourcePanel, entry.turnIdx, entry.path);
    card.appendChild(header);

    if (entry.subitems.length > 0) {
      const list = doc.createElement("div");
      list.className = "pp-debug-logs-list";
      entry.subitems.forEach((sub) => list.appendChild(buildLogsCard(doc, sub)));
      card.appendChild(list);
    } else if (entry.bodyText) {
      const pre = doc.createElement("pre");
      pre.className = "pp-debug-logs-body";
      pre.textContent = entry.bodyText;
      card.appendChild(pre);
    }

    return card;
  }

  function renderPipContent(win, data) {
    const doc = win.document;
    doc.title = data.title;

    let root = doc.querySelector(".pp-root");
    if (!root) {
      root = doc.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <div class="pp-header">
          <div class="pp-header-title"></div>
          <div class="pp-header-meta"></div>
        </div>
        <div class="pp-transcript"></div>
        <div class="pp-audio-bar" hidden>
          <div class="pp-audio-loading"><div class="pp-spinner"></div><span>Loading audio…</span></div>
          <div class="pp-audio-row">
            <button class="pp-audio-btn" type="button" aria-label="Play/Pause">▶</button>
            <span class="pp-audio-time">0:00 / 0:00</span>
            <span class="pp-audio-hint">play/pause synced; skim in source tab</span>
          </div>
          <div class="pp-waveforms"></div>
          <div class="pp-audio-progress"><div class="pp-audio-progress-fill"></div></div>
        </div>
      `;
      doc.body.appendChild(root);
    }

    root.querySelector(".pp-header-title").textContent = data.title;
    root.querySelector(".pp-header-meta").textContent = data.sid || "";

    const transcriptEl = root.querySelector(".pp-transcript");
    transcriptEl.innerHTML = "";

    if (data.turns.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "pp-empty";
      empty.textContent = "No transcript turns found for this conversation.";
      transcriptEl.appendChild(empty);
    } else {
      // Each turn's debug entries render *inside* the same group as its
      // bubble (tight internal gap — see .pp-turn-group in pip.css) so
      // they read as "this is what happened around this message," not
      // as their own unrelated item — reported live that at the old flat
      // structure (debug strip and bubble as plain uniform-gap siblings
      // of .pp-transcript), a turn's debug info looked exactly as
      // separated from *its own* bubble as from the *next* turn's, with
      // no visual grouping at all. The larger gap moves up to *between*
      // groups instead (.pp-transcript's own gap), which is also the
      // "a bit more space between messages" fix.
      data.turns.forEach((turn) => {
        const group = doc.createElement("div");
        group.className = "pp-turn-group";

        if (turn.debugBefore && turn.debugBefore.length > 0) {
          group.appendChild(buildDebugStrip(doc, turn.debugBefore));
        }

        const row = doc.createElement("div");
        row.className = `pp-turn pp-turn-${turn.speaker.toLowerCase()}`;
        row.dataset.turnIdx = turn.turnIdx;

        const speakerEl = doc.createElement("div");
        speakerEl.className = "pp-turn-speaker";
        speakerEl.textContent = turn.speaker;

        const textEl = doc.createElement("div");
        textEl.className = "pp-turn-text";
        textEl.textContent = turn.text;

        row.appendChild(speakerEl);
        row.appendChild(textEl);

        if (turn.original) {
          const originalEl = doc.createElement("div");
          originalEl.className = "pp-turn-original";
          originalEl.textContent = turn.original;
          row.appendChild(originalEl);
        }

        group.appendChild(row);
        transcriptEl.appendChild(group);
      });

      // Not part of any turn's group — this is whatever debug content
      // trailed after the very last utterance, with nothing of its own
      // to visually attach to.
      if (data.trailingDebug && data.trailingDebug.length > 0) {
        transcriptEl.appendChild(buildDebugStrip(doc, data.trailingDebug));
      }
    }

    const audioBar = root.querySelector(".pp-audio-bar");
    const audioLoadingEl = root.querySelector(".pp-audio-loading");
    const audioRowEl = root.querySelector(".pp-audio-row");
    const waveformsEl = root.querySelector(".pp-waveforms");
    const fallbackBar = root.querySelector(".pp-audio-progress");

    audioBar.hidden = !data.hasAudio;

    // hasAudio-but-not-audioReady (still loading) gets its own loading
    // state, not the real controls with whatever's currently available —
    // that was the bug: showing the audio row before it was truly ready
    // could present the *previous* conversation's stale duration as if it
    // were current, with no waveform, and nothing ever corrected it (see
    // maybeRefreshPipForContentChange for the other half of that fix).
    if (data.hasAudio && !data.audioReady) {
      audioLoadingEl.hidden = false;
      audioRowEl.hidden = true;
      waveformsEl.hidden = true;
      fallbackBar.hidden = true;
      return;
    }
    audioLoadingEl.hidden = true;
    audioRowEl.hidden = false;

    // Real waveform pixels captured from Studio's own <canvas> (see
    // captureWaveformImages) when available; falls back to the plain
    // progress bar if capture came back empty for any reason.
    waveformsEl.innerHTML = "";

    if (data.waveforms.length > 0) {
      fallbackBar.hidden = true;
      waveformsEl.hidden = false;
      data.waveforms.forEach((track) => {
        const row = doc.createElement("div");
        row.className = "pp-waveform-track";
        row.innerHTML = `
          <span class="pp-waveform-label">${track.label}</span>
          <div class="pp-waveform-visual">
            <img class="pp-waveform-img" alt="${track.label} waveform">
            <div class="pp-waveform-playhead"></div>
          </div>
        `;
        row.querySelector(".pp-waveform-img").src = track.dataUrl;
        waveformsEl.appendChild(row);
      });
    } else {
      waveformsEl.hidden = true;
      fallbackBar.hidden = false;
    }
  }

  function wireAudioRemoteControl(win, panel) {
    pipAudioRemote?.destroy();
    pipAudioRemote = null;

    const doc = win.document;
    const audioBtn = doc.querySelector(".pp-audio-btn");
    const timeEl = doc.querySelector(".pp-audio-time");
    const progressFill = doc.querySelector(".pp-audio-progress-fill");
    // Not just "does the button exist" — renderPipContent already hides
    // the whole controls row behind the loading state until isAudioReady,
    // so there's nothing to wire up yet if it isn't.
    if (!audioBtn || !isAudioReady(panel)) return;

    const remote = createAudioRemote(panel, win);
    pipAudioRemote = remote;

    const playheadEls = doc.querySelectorAll(".pp-waveform-playhead");
    let lastPaintedSecond = null;

    // Display-only — no click-to-seek. Confirmed live, twice, via two
    // different mechanisms (see DESIGN_SPEC.md): a synthetic click on
    // Studio's waveform does nothing (requires a trusted event), and
    // directly writing the underlying <audio>.currentTime also doesn't
    // move Studio's own playback/UI. The playhead line below is purely a
    // position indicator over the real waveform image, not a control.
    //
    // `state.currentSeconds` here is already dead-reckoned/interpolated
    // by createAudioRemote and arrives once per animation frame while
    // playing — so the position write happens every frame (cheap, a style
    // write), but the time-text write is throttled to once per whole
    // second changed, since redrawing identical "0:31" text 60x/sec would
    // just be wasted work with no visible benefit.
    function paint(state) {
      const pct = state.durationSeconds > 0 ? (state.currentSeconds / state.durationSeconds) * 100 : 0;
      const clampedPct = Math.min(100, Math.max(0, pct));
      progressFill.style.width = `${clampedPct}%`;
      playheadEls.forEach((el) => {
        el.style.left = `${clampedPct}%`;
      });

      const roundedSecond = Math.floor(state.currentSeconds);
      if (roundedSecond === lastPaintedSecond && audioBtn.dataset.playing === String(state.isPlaying)) return;
      lastPaintedSecond = roundedSecond;
      audioBtn.dataset.playing = String(state.isPlaying);
      audioBtn.textContent = state.isPlaying ? "⏸" : "▶";
      timeEl.textContent = `${formatClock(state.currentSeconds)} / ${formatClock(state.durationSeconds)}`;
    }

    audioBtn.onclick = () => {
      remote.togglePlayPause();
      // Optimistic repaint; the next poll tick will correct it shortly.
      setTimeout(() => paint(remote.currentState()), 50);
    };

    remote.onTick(paint);
    paint(remote.currentState());
  }

  async function openOrUpdatePip(panel, { force = false } = {}) {
    if (!window.documentPictureInPicture) {
      console.warn("[PolyPin] documentPictureInPicture is not supported in this browser.");
      return;
    }

    // Belt-and-suspenders: the trigger button is already disabled while
    // !isConversationReady (see injectPipButtons), and the nav-swap wait
    // loop already waits on this same check before calling in here — but
    // guard it here too, since this is the one function that actually
    // opens/mutates the PiP, and it should never do so with incomplete
    // data regardless of which caller reaches it. `force` is the one
    // deliberate exception: the nav-swap wait loop's own ~4.5s timeout
    // fallback needs to show *something* rather than get stuck forever
    // showing the previous conversation if audio genuinely never loads.
    if (!force && !isConversationReady(panel)) return;

    const data = scrapeConversation(panel);
    pipSourcePanel = panel;
    const isNewWindow = !pipWindow || pipWindow.closed;

    if (isNewWindow) {
      pipWindow = await window.documentPictureInPicture.requestWindow({ width: 420, height: 600 });
      const style = pipWindow.document.createElement("style");
      style.textContent = await getPipCssText();
      pipWindow.document.head.appendChild(style);
      pipWindow.addEventListener("pagehide", teardownPip);
    }

    applyPipTheme(pipWindow); // before renderPipContent so a fresh window never paints in the wrong theme first
    renderPipContent(pipWindow, data);
    wireAudioRemoteControl(pipWindow, panel);
    lastRenderedFingerprint = pipContentFingerprint(data);

    if (isNewWindow) updateAllButtonStates();
  }

  function closePip() {
    if (pipWindow && !pipWindow.closed) pipWindow.close();
  }

  function teardownPip() {
    pipAudioRemote?.destroy();
    pipAudioRemote = null;
    pipWindow = null;
    pipSourcePanel = null;
    lastRenderedFingerprint = null;
    updateAllButtonStates();
  }

  function refreshPipIfOpen(panel, opts) {
    if (pipWindow && !pipWindow.closed) openOrUpdatePip(panel, opts);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Section: Trigger button injection
  // ──────────────────────────────────────────────────────────────────────

  // 48px source downscaled to the button's 28px render size — crisper than
  // upscaling icon16.png would be.
  const PIP_ICON_URL = chrome.runtime.getURL("icons/icon48.png");

  function buildPipButton(panel) {
    const btn = document.createElement("button");
    btn.className = "pp-pip-btn";
    btn.setAttribute("aria-label", "Pop out in PolyPin");
    btn.innerHTML = `<img src="${PIP_ICON_URL}" alt="">`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openOrUpdatePip(panel);
    });
    return btn;
  }

  // Greys the button out and disables it until isConversationReady — see
  // that function for why: opening a PiP before the audio player has
  // mounted used to silently produce one whose play button did nothing for
  // its whole lifetime. `btn.disabled` blocks the click natively (no click
  // event fires at all), so this is the actual gate — openOrUpdatePip's own
  // internal check is just a backstop for the other call sites.
  function updateAllButtonStates() {
    const panels = getTranscriptPanels();
    document.querySelectorAll(".pp-pip-btn").forEach((btn) => {
      btn.classList.toggle("pp-active", Boolean(pipWindow && !pipWindow.closed));

      const owningPanel = panels.find((p) => p.contains(btn));
      const ready = Boolean(owningPanel && isConversationReady(owningPanel));
      btn.disabled = !ready;
      btn.classList.toggle("pp-loading", !ready);
      btn.title = ready ? "Pop out in PolyPin" : "Loading call…";
    });
  }

  function injectPipButtons() {
    const panels = getTranscriptPanels();

    if (panels.length === 0) {
      document.querySelectorAll(".pp-pip-btn").forEach((el) => el.remove());
      return;
    }

    const activePanels = new Set(panels);
    document.querySelectorAll(".pp-pip-btn").forEach((btn) => {
      const owningPanel = panels.find((p) => p.contains(btn));
      if (!owningPanel || !activePanels.has(owningPanel)) btn.remove();
    });

    panels.forEach((panel) => {
      const existing = panel.querySelector(".pp-pip-btn");
      if (existing && isButtonWellPlaced(existing, panel)) return;
      if (existing) existing.remove();

      const anchor = findPipButtonAnchor(panel);
      if (!anchor) return;

      const btn = buildPipButton(panel);
      anchor.el.insertBefore(btn, anchor.insertBefore || anchor.el.firstChild);
    });

    updateAllButtonStates();
  }

  // ──────────────────────────────────────────────────────────────────────
  // Section: PiP Lifecycle — Navigation Handling
  //
  // Confirmed live: Studio's in-app navigation (Next/Prev, sidebar
  // open/close) goes exclusively through history.pushState/replaceState,
  // never a hard reload, never a bare popstate. The monkey-patch below is
  // confirmed sufficient on its own — see DESIGN_SPEC.md Open Question #5.
  //
  // Behavior:
  //   - CALL_SID disappears entirely (left conversation view)  → close PiP
  //   - CALL_SID changes to a different value (swapped calls)  → update PiP
  //   - CALL_SID unchanged (unrelated re-render, new turns etc) → no-op
  // ──────────────────────────────────────────────────────────────────────

  let lastKnownSid = getCurrentCallSid();

  // A cheap fingerprint for "is this still the same rendered conversation".
  // Confirmed live (see DESIGN_SPEC.md): the URL/SID updates immediately via
  // pushState, but Studio keeps the *previous* conversation's turns on
  // screen while it fetches the new one's data — there's no loading/blank
  // state in between. A fixed delay before re-scraping is a guess that can
  // easily lose the race on a slow network; this waits for the DOM to
  // actually change instead.
  function panelFingerprint(panel) {
    const firstTurn = getFirstTurn(panel);
    if (!firstTurn) return "";
    return `${firstTurn.getAttribute("data-turn-idx") || ""}::${firstTurn.textContent.slice(0, 200)}`;
  }

  // A second, differently-scoped fingerprint: panelFingerprint (above)
  // only needs to catch "this is now a different conversation" — raw
  // textContent is fine for that, since two different turns will almost
  // certainly differ within the first 200 characters regardless of where
  // the dialogue itself sits. This one needs something stricter: "same
  // conversation, but its rendered *dialogue* changed" — PolyTranslate
  // toggling being the case that broke it. A turn's raw textContent
  // includes everything in its debug/flow panel too (flow step names,
  // "Logs", latency numbers, "Entered X") — confirmed live that on a real
  // turn, all of that preamble runs well past 100 characters *before* the
  // actual utterance even starts, so comparing truncated raw textContent
  // never actually looked at text translation would change at all. Fixed
  // by fingerprinting the already-cleanly-extracted turns.text instead —
  // the exact same text getDisplayText hands to the renderer, which
  // already correctly reads .pt-translated when present.
  //
  // Also folds in each turn's debugBefore entries (see
  // collectTurnDebugEntries) — deliberately, this time, rather than
  // stripping them: toggling Studio's own "Debug options" checkboxes, or
  // expanding/collapsing its Logs accordion, is exactly the kind of
  // same-conversation content change this fingerprint exists to catch,
  // so the periodic maybeRefreshPipForContentChange poll re-renders the
  // PiP within one tick, with no dedicated toggle-watching code of our
  // own. debugEntryKey serializes each entry's *content* (label/values/
  // subitems/bodyText) — deliberately not `turnIdx`/`path` (see
  // buildLogsCardEntry), since those identify *where to click later*,
  // not what's currently displayed; including them would force a
  // pointless re-render every time a Logs card's turnIdx happened to
  // differ without its actual content changing at all.
  function debugEntryKey(entry) {
    switch (entry.kind) {
      case "card":
        // subitems are full nested entries now (Logs recurses — see
        // buildLogsCardEntry), not plain strings, so this must recurse
        // too rather than joining them directly (which would just
        // stringify each as "[object Object]"). bodyText (a leaf log
        // entry's JSON payload) is folded in for the same reason
        // audioReady/trailingDebug are elsewhere in this file: expanding
        // it on the source page is a content change this fingerprint
        // needs to notice.
        return `card:${entry.label}[${entry.subitems.map(debugEntryKey).join(",")}]${entry.bodyText ? ":" + entry.bodyText.slice(0, 200) : ""}`;
      case "chipgroup":
        return `chip:${entry.label}:${entry.values.join(",")}`;
      case "flow":
        return `flow:${entry.text}`;
      default:
        return `text:${entry.text}`;
    }
  }

  // Deliberately NOT truncated (an earlier version sliced this to the
  // first 1000 characters, matching panelFingerprint's much narrower
  // "did the conversation swap to a different one" check above). Reported
  // live on a longer call: expanding a Logs card on turn 12 of ~13 never
  // updated the PiP at all — root cause, confirmed live by comparing the
  // fingerprint before/after by hand, was exactly this slice discarding
  // the entire back half of the conversation, including that turn's
  // debugBefore, from ever being compared. Unlike panelFingerprint (which
  // only needs *some* difference near the start to prove "this is a
  // different conversation"), this fingerprint has to notice a change
  // *anywhere*, including deep into a long call — a fixed prefix cutoff
  // is fundamentally the wrong shape for that job, not just a size tuned
  // too small. A full string compare of even a long conversation's worth
  // of dialogue + debug text is still cheap next to the DOM walk that
  // built it in the first place.
  function turnsFingerprint(turns) {
    const text = turns.map((t) => t.text + "»" + (t.debugBefore || []).map(debugEntryKey).join("·")).join("|");
    return `${turns.length}::${text}`;
  }

  // Folds audioReady into the same fingerprint as the dialogue text.
  // Without this, a PiP rendered while audio was still loading (the
  // waitForConversationSwap timeout's force:true fallback, or any other
  // race) would never get a second chance — the transcript fingerprint
  // alone stabilizes as soon as the dialogue is correct, so nothing would
  // notice audio quietly becoming ready moments later. Confirmed live:
  // this was exactly the reported symptom — transcript loads fine, audio
  // permanently stuck showing the previous call's stale duration.
  // trailingDebug (leftover debug entries after the last utterance) is
  // folded in for the same reason turnsFingerprint includes debugBefore —
  // and, per that function's own comment, not truncated for the same
  // reason: a fixed prefix cutoff can silently discard the very change
  // this exists to catch.
  function pipContentFingerprint(data) {
    const trailing = (data.trailingDebug || []).map(debugEntryKey).join("·");
    return `${turnsFingerprint(data.turns)}::${data.audioReady}::${trailing}`;
  }

  // Hooked into the same page-wide mutation observer that already keeps
  // the trigger button correctly placed (see Page-wide re-render
  // resilience, below) — reuses that existing signal rather than adding a
  // second polling loop. Deliberately does *not* handle SID changes here;
  // that's waitForConversationSwap's job, gated on lastKnownSid so the two
  // mechanisms don't double-handle the same transition.
  function maybeRefreshPipForContentChange() {
    if (!pipWindow || pipWindow.closed || !pipSourcePanel?.isConnected) return;
    if (getCurrentCallSid() !== lastKnownSid) return;

    // Independent of the content-fingerprint check below on purpose: the
    // user can flip Studio's own light/dark preference at any time while
    // the PiP is already open, with no conversation *content* change at
    // all to otherwise trigger a re-render through the fingerprint path.
    applyPipTheme(pipWindow);

    const fingerprintNow = pipContentFingerprint(scrapeConversation(pipSourcePanel));
    if (fingerprintNow === lastRenderedFingerprint) return;
    openOrUpdatePip(pipSourcePanel);
  }

  function waitForConversationSwap(fingerprintBefore, targetSid, attempt = 0) {
    const MAX_ATTEMPTS = 30; // ~30 * 150ms = 4.5s ceiling, then give up and use whatever's there

    // Bail if a newer navigation has already superseded this one.
    if (getCurrentCallSid() !== targetSid) return;

    const panel = getTranscriptPanels()[0] || null;
    const fingerprintNow = panel ? panelFingerprint(panel) : "";
    const changed = panel && fingerprintNow && fingerprintNow !== fingerprintBefore;
    const timedOut = attempt >= MAX_ATTEMPTS;

    // Wait for the swap *and* full readiness (audio player mounted, if this
    // is a voice call) before refreshing — otherwise a PiP already open
    // when Next/Prev fires could update into the same "play button does
    // nothing" state the trigger-button gating exists to prevent. `force`
    // on timeout keeps the existing "give up and show whatever's there
    // after ~4.5s" behavior rather than getting stuck forever.
    if ((changed && panel && isConversationReady(panel)) || timedOut) {
      if (panel) refreshPipIfOpen(panel, { force: timedOut });
      injectPipButtons();
      return;
    }

    setTimeout(() => waitForConversationSwap(fingerprintBefore, targetSid, attempt + 1), 150);
  }

  // Shown the instant a navigation is detected, before we know how long
  // the new conversation will take to become ready — otherwise the PiP
  // just silently kept showing the *previous* call's transcript/audio for
  // however long the wait took, which reads as stale/broken rather than
  // loading. Also stops the old call's audio-position polling/animation
  // loop immediately, since pipSourcePanel is about to point at content
  // that's no longer the one it should be tracking.
  function showPipLoadingState() {
    if (!pipWindow || pipWindow.closed) return;

    pipAudioRemote?.destroy();
    pipAudioRemote = null;

    const doc = pipWindow.document;
    const root = doc.querySelector(".pp-root");
    if (!root) return;

    root.querySelector(".pp-header-title").textContent = "Loading call…";
    root.querySelector(".pp-header-meta").textContent = "";

    const transcriptEl = root.querySelector(".pp-transcript");
    transcriptEl.innerHTML = `<div class="pp-empty pp-loading-state"><div class="pp-spinner"></div><div>Loading call…</div></div>`;

    root.querySelector(".pp-audio-bar").hidden = true;
  }

  function handleNavigationChange() {
    const sid = getCurrentCallSid();
    if (sid === lastKnownSid) return;
    lastKnownSid = sid;

    if (!sid) {
      closePip();
      return;
    }

    showPipLoadingState();

    const panelBefore = getTranscriptPanels()[0] || null;
    const fingerprintBefore = panelBefore ? panelFingerprint(panelBefore) : "";
    waitForConversationSwap(fingerprintBefore, sid);
  }

  // A monkey-patch on history.pushState/replaceState was the original
  // approach here (and tested fine in isolation — see DESIGN_SPEC.md).
  // **Confirmed broken in production**: Studio also loads a third-party
  // observability/analytics bundle that patches history.pushState itself,
  // and it wins whatever the patch ordering ends up being — the net result
  // was our hook getting silently orphaned with no error, ever, so PiP
  // updates for Next/Prev never fired at all (proven by testing across
  // multiple real navigations with no update, well past our own timeout).
  // There's no reliable way to guarantee we're "last" against a
  // third-party script we don't control the load order of. Polling
  // location directly sidesteps the whole problem — it doesn't depend on
  // any hook surviving, just on reading the URL, which nothing can
  // intercept or shadow.
  setInterval(handleNavigationChange, 400);

  // maybeRefreshPipForContentChange (content-change detection) is hooked
  // into the page-wide MutationObserver, which only watches childList
  // mutations — but confirmed live that's fundamentally insufficient for
  // audio readiness specifically: Studio flips the play button's
  // `disabled` attribute with no nodes added/removed (an attributes
  // mutation our observer doesn't subscribe to at all), and painting the
  // waveform canvas happens via Canvas 2D API calls, which are *never*
  // visible to MutationObserver under any configuration — there's no DOM
  // mutation to observe. Once a conversation's transcript itself stops
  // changing, nothing was left to ever re-trigger the check, so a PiP
  // stuck showing the loading state could stay stuck indefinitely even
  // after the real page finished loading. Polling sidesteps the whole
  // "can this even be observed" question, same reasoning as the
  // navigation-detection poll above. The WeakSet cache in
  // canvasHasRealContent keeps this cheap once a canvas is confirmed
  // ready — this only ever does real work while something's still loading.
  setInterval(maybeRefreshPipForContentChange, 600);

  // Same gap, same fix, applied to the trigger button's own grey/loading
  // state — it's driven by this exact same mutation-observer path
  // (injectPipButtons → updateAllButtonStates), so it could get stuck
  // showing "loading" forever for the same reason.
  setInterval(injectPipButtons, 600);

  // ──────────────────────────────────────────────────────────────────────
  // Section: Page-wide re-render resilience
  //
  // Reused pattern from PolyTranslate's pageObserver: the SPA keeps
  // re-rendering, so the button needs to be re-checked/re-injected on any
  // relevant DOM change, ignoring mutations that are just our own injected
  // elements (avoids feedback loops).
  // ──────────────────────────────────────────────────────────────────────

  function isIgnorableDomMutation(mutations) {
    const changed = [];
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) changed.push(node);
      });
      mutation.removedNodes.forEach((node) => {
        if (node.nodeType === 1) changed.push(node);
      });
    }
    if (changed.length === 0) return true;

    return changed.every((node) => {
      if (node.matches?.(".pp-pip-btn")) return true;
      return Boolean(node.closest?.(".pp-pip-btn"));
    });
  }

  let pageObserverDebounce = null;
  const pageObserver = new MutationObserver((mutations) => {
    if (!chrome.runtime?.id) {
      pageObserver.disconnect();
      return;
    }
    if (isIgnorableDomMutation(mutations)) return;
    if (pageObserverDebounce) return;
    pageObserverDebounce = setTimeout(() => {
      pageObserverDebounce = null;
      injectPipButtons();
      maybeRefreshPipForContentChange();
    }, 200);
  });

  function init() {
    injectPipButtons();
    pageObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
