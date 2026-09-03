// ==UserScript==
// @name         GitHub PR Approve Helper
// @namespace    https://github.com/MishaKav/userscripts/github-pr-approve-helper
// @version      1.3.0
// @description  Auto-fills the review comment with LGTM on Approve, adds a quick-approve button and can approve a whole stack of PRs
// @author       Misha Kav
// @copyright    2026, Misha Kav
// @match        https://github.com/linear-b/*
// @icon         https://github.com/favicon.ico
// @grant        none
// @sandbox      DOM
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/MishaKav/userscripts/main/github-pr-approve-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/MishaKav/userscripts/main/github-pr-approve-helper.user.js
// @supportURL   https://github.com/MishaKav/userscripts/issues
// ==/UserScript==

(function () {
  'use strict';

  // keep in sync with @version above, shown in the logs and the badge
  const VERSION = '1.3.0';

  // automatically select the approve option when the review dialog opens
  const AUTO_SELECT_APPROVE = true;

  // always inserted on approve - pick from the dropdown to replace it
  const DEFAULT_COMMENT = 'LGTM';

  // the alternatives offered in the dropdown ('🎲 Random' picks one of these)
  const APPROVE_COMMENTS = [
    'LGTM',
    'Nice',
    'Looks good to me!',
    'Great job! 🎉',
    'Well done 💪',
    'Clean and simple, LGTM 🔥',
  ];

  // the script only fills comments on PRs of these orgs/users, add as you like
  // (checked at runtime in addition to @match, so it stays correct when
  // github soft-navigates between orgs without a full page load)
  const ALLOWED_ORGS = ['linear-b'];

  // marker for text we inserted, so we never delete anything the user typed
  const AUTO_FILL_ATTRIBUTE = 'data-approve-helper-text';

  // marker for dialogs we already processed, so the "approve pre-selected on
  // open" fill happens once per open and never fights the user
  const SEEN_ATTRIBUTE = 'data-approve-helper-seen';

  // show a floating quick-approve button on PR pages - click it to pick a
  // comment and approve the PR without opening the review dialog
  const SHOW_QUICK_APPROVE = true;

  // on a PR that is part of a github stack, offer "approve whole stack" in
  // the right-click menu of the quick-approve button. the plain click still
  // approves only the current PR - the stack run is always a manual pick
  const STACK_APPROVE = true;

  const DROPDOWN_ID = 'gpah-comment-select';
  const BUTTON_ID = 'gpah-quick-approve';
  const MENU_ID = 'gpah-quick-approve-menu';
  const INDICATOR_ID = 'gpah-approved-badge';

  // set while the quick-approve button is busy or showing its result, so
  // the page scan leaves it alone until it returns to idle
  const BUTTON_STATE_ATTRIBUTE = 'data-gpah-state';
  const RANDOM_OPTION_VALUE = '__random__';

  // 'pull_request_review[event]' - legacy "Review changes" dropdown
  // 'reviewEvent'                - new react "Finish your review" dialog
  const REVIEW_RADIO_NAMES = ['pull_request_review[event]', 'reviewEvent'];

  const SELECTORS = {
    REVIEW_CONTAINER:
      '#review-changes-modal, form[action*="/reviews"], dialog, [role="dialog"]',
    REVIEW_RADIOS: REVIEW_RADIO_NAMES.map(
      (name) => `input[type="radio"][name="${name}"]`,
    ).join(', '),
    REVIEW_TEXTAREAS: [
      'textarea#pull_request_review_body', // legacy dropdown
      'textarea[name="pull_request_review[body]"]', // legacy fallback
      'textarea[aria-label="Markdown value"]', // new react dialog
      'textarea[placeholder="Leave a comment"]', // react fallback
      'textarea', // last resort, scoped to the review container only
    ],
    // the merged/closed badge in the pr header. the react markup (verified
    // on a real pr) is <span data-component="StateLabel" data-status="pullMerged">
    STATE_BADGE:
      '[data-component="StateLabel"], .State, [class*="StateLabel"], [title^="Status:"]',
    // small elements whose own text can say "<user> approved these
    // changes": reviewer tooltips and timeline entries. deliberately NO
    // sidebar/section containers - their concatenated text can juxtapose my
    // name with someone else's approval and produce a false positive
    REVIEW_APPROVAL_TEXT:
      'tool-tip, [aria-label*="approved these changes" i], .TimelineItem-body, .TimelineItem',
  };

  const parsePrPath = () => {
    const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return match && { owner: match[1], repo: match[2], number: match[3] };
  };

  const prKey = (pr) => `${pr.owner}/${pr.repo}#${pr.number}`;

  const prPagePath = (pr, page = '') =>
    `/${pr.owner}/${pr.repo}/pull/${pr.number}${page ? `/${page}` : ''}`;

  const isPullRequestPage = () => Boolean(parsePrPath());

  const isAllowedOrgPage = () =>
    ALLOWED_ORGS.some((org) =>
      location.pathname.toLowerCase().startsWith(`/${org.toLowerCase()}/`),
    );

  const isReviewRadio = (el) =>
    el?.matches?.('input[type="radio"]') &&
    (REVIEW_RADIO_NAMES.includes(el.name) ||
      /^(approve|comment|reject|request[ _-]?changes)$/i.test(el.value));

  const isApprove = (radio) => /^approve$/i.test(radio.value);

  // matches both the opener on the files page and the dialog's own submit
  const isSubmitReviewButton = (el) =>
    /^submit review/i.test(el.textContent.trim());

  const pickComment = () =>
    APPROVE_COMMENTS[Math.floor(Math.random() * APPROVE_COMMENTS.length)];

  const getReviewTextarea = (container) => {
    for (const selector of SELECTORS.REVIEW_TEXTAREAS) {
      const textarea = container.querySelector(selector);
      if (textarea) {
        return textarea;
      }
    }
    return null;
  };

  // dialog-ish containers that are real review dialogs: they contain the
  // approve/comment radios and a comment textarea
  const findReviewDialogs = () =>
    [...document.querySelectorAll(SELECTORS.REVIEW_CONTAINER)].filter(
      (el) => el.querySelector(SELECTORS.REVIEW_RADIOS) && getReviewTextarea(el),
    );

  // react-controlled textarea ignores a plain `.value =`, so assign through
  // the native prototype setter and fire bubbled events for react to notice
  const setNativeValue = (textarea, text) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(textarea, text);
    } else {
      textarea.value = text;
    }

    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // set the text and mark it as ours - clearAutoComment only removes text
  // that still exactly matches this marker
  const insertAutoComment = (textarea, text) => {
    setNativeValue(textarea, text);
    textarea.setAttribute(AUTO_FILL_ATTRIBUTE, text);
  };

  const fillComment = (textarea) => {
    // never overwrite anything the user already typed
    if (textarea.value.trim() !== '') {
      return;
    }

    insertAutoComment(textarea, DEFAULT_COMMENT);
    console.log(`[GitHub PR Approve Helper] filled review comment: "${DEFAULT_COMMENT}"`);
  };

  const clearAutoComment = (textarea) => {
    const autoText = textarea.getAttribute(AUTO_FILL_ATTRIBUTE);

    // not inserted by us, or edited by the user since - keep it
    if (autoText === null || textarea.value !== autoText) {
      return;
    }

    setNativeValue(textarea, '');
    textarea.removeAttribute(AUTO_FILL_ATTRIBUTE);
    console.log('[GitHub PR Approve Helper] cleared auto comment');
  };

  const handleReviewRadio = (radio) => {
    if (!radio.checked) {
      return;
    }

    const container = radio.closest(SELECTORS.REVIEW_CONTAINER);
    const textarea = container && getReviewTextarea(container);

    if (!textarea) {
      return;
    }

    if (isApprove(radio)) {
      fillComment(textarea);
    } else {
      clearAutoComment(textarea);
    }
  };

  // use composedPath so the real target is found even inside shadow dom
  const getEventTarget = (event) => {
    const target = event.composedPath?.()[0] ?? event.target;
    return target instanceof Element ? target : null;
  };

  const onReviewOptionChange = (event) => {
    if (!isPullRequestPage() || !isAllowedOrgPage()) {
      return;
    }

    const radio = getEventTarget(event);

    if (isReviewRadio(radio)) {
      handleReviewRadio(radio);
    }
  };

  // fallback for clicks that don't produce a change event, e.g. clicking the
  // approve option when it's already selected, or clicking its label
  const onReviewOptionClick = (event) => {
    if (!isPullRequestPage() || !isAllowedOrgPage()) {
      return;
    }

    const target = getEventTarget(event);
    const radio = target?.matches?.('input[type="radio"]')
      ? target
      : target?.closest('label')?.control;

    if (!isReviewRadio(radio)) {
      return;
    }

    // let the browser/react finish updating the checked state first
    setTimeout(() => handleReviewRadio(radio), 0);
  };

  const createCommentDropdown = () => {
    const select = document.createElement('select');
    select.id = DROPDOWN_ID;
    // compact pill floating in the dialog header, next to the close button -
    // it never disturbs the layout of the react-rendered dialog content
    select.style.cssText = [
      'position: absolute',
      'top: 12px',
      'right: 48px',
      'max-width: 200px',
      'padding: 4px 8px',
      'font-size: 12px',
      'font-weight: 500',
      'color: #1f2328',
      'background: #f6f8fa',
      'border: 1px solid #d0d7de',
      'border-radius: 6px',
      'cursor: pointer',
      'z-index: 100',
    ].join(';');

    const options = [
      { value: '', text: `💬 ${DEFAULT_COMMENT}…` },
      { value: RANDOM_OPTION_VALUE, text: '🎲 Random' },
      ...APPROVE_COMMENTS.map((comment) => ({ value: comment, text: comment })),
    ];

    for (const { value, text } of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }

    select.addEventListener('change', () => {
      const comment =
        select.value === RANDOM_OPTION_VALUE ? pickComment() : select.value;
      // back to the placeholder, so the same option can be picked again
      select.selectedIndex = 0;

      const container = select.closest(SELECTORS.REVIEW_CONTAINER);
      const textarea = container && getReviewTextarea(container);

      if (!comment || !textarea) {
        return;
      }

      // explicit pick from the dropdown replaces whatever is in the box
      insertAutoComment(textarea, comment);
      textarea.focus();
      console.log(`[GitHub PR Approve Helper] inserted comment: "${comment}"`);
    });

    return select;
  };

  // ===== QUICK APPROVE =====

  const safeJsonParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  // walk a parsed react payload for a `csrf_tokens: {path: {method: token}}`
  // object, the way the new github ui embeds its csrf tokens
  const findCsrfTokensMap = (node) => {
    if (!node || typeof node !== 'object') {
      return null;
    }
    if (node.csrf_tokens && typeof node.csrf_tokens === 'object') {
      return node.csrf_tokens;
    }
    for (const value of Object.values(node)) {
      const found = findCsrfTokensMap(value);
      if (found) {
        return found;
      }
    }
    return null;
  };

  // the failure diagnostic keeps at most this many token paths, so a huge
  // csrf_tokens map can't flood the console on every fallback
  const MAX_DIAGNOSTIC_PATHS = 20;

  // scan one document for a review csrf token, in every known place github
  // puts one: the legacy review form, then the csrf_tokens maps embedded in
  // the json payloads of the new react pages. also returns what was
  // searched (a count and a bounded sample of paths, never token values),
  // so the failure diagnostic always describes the actual search
  const scanForReviewToken = (doc, pr) => {
    const scripts = [...doc.querySelectorAll('script[type="application/json"]')];
    const stats = {
      jsonScripts: scripts.length,
      reviewForms: doc.querySelectorAll('form[action$="/reviews"]').length,
      csrfTokenPathCount: 0,
      csrfTokenPaths: [],
    };

    // only accept a form that belongs to THIS pr - a stale form from a
    // previous soft navigation must not approve the wrong pr
    const form = doc.querySelector(
      `form[action$="/pull/${pr.number}/reviews"]`,
    );
    const formToken = form?.querySelector(
      'input[name="authenticity_token"]',
    )?.value;

    if (formToken) {
      return {
        found: { token: formToken, path: form.getAttribute('action') },
        stats,
      };
    }

    for (const script of scripts) {
      // github embeds huge page payloads in these scripts - skip the json
      // parse and walk for the ones that can't contain a csrf_tokens map
      if (!script.textContent.includes('csrf_tokens')) {
        continue;
      }

      const map = findCsrfTokensMap(safeJsonParse(script.textContent));
      if (!map) {
        continue;
      }

      const paths = Object.keys(map);
      stats.csrfTokenPathCount += paths.length;
      stats.csrfTokenPaths.push(
        ...paths.slice(
          0,
          Math.max(0, MAX_DIAGNOSTIC_PATHS - stats.csrfTokenPaths.length),
        ),
      );

      const entry = Object.entries(map).find(([path]) =>
        path.endsWith(`/pull/${pr.number}/reviews`),
      );

      if (entry) {
        const [path, tokens] = entry;
        const token = tokens?.post ?? Object.values(tokens ?? {})[0];
        if (token) {
          return { found: { token, path }, stats };
        }
      }
    }

    return { found: null, stats };
  };

  // approve the PR the same way github's own ui does: find a fresh csrf
  // token (on the live page, or on the fetched files page) and post the
  // approve to the reviews endpoint with the session cookies
  const submitApproval = async (comment, pr) => {
    // the page we're already on may embed the token
    const liveScan = scanForReviewToken(document, pr);
    let filesScan = null;
    let found = liveScan.found;

    if (!found) {
      const filesResponse = await fetch(prPagePath(pr, 'files'), {
        credentials: 'include',
      });

      if (!filesResponse.ok) {
        throw new Error(`review form page failed to load (${filesResponse.status})`);
      }

      const filesDoc = new DOMParser().parseFromString(
        await filesResponse.text(),
        'text/html',
      );
      filesScan = scanForReviewToken(filesDoc, pr);
      found = filesScan.found;
    }

    if (!found) {
      console.log(
        '[GitHub PR Approve Helper] csrf discovery details:',
        JSON.stringify({
          livePage: liveScan.stats,
          filesPage: filesScan?.stats ?? null,
        }),
      );
      throw new Error(
        'no csrf token found - paste the "csrf discovery details" console line to debug',
      );
    }

    const submitResponse = await fetch(new URL(found.path, location.origin), {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({
        authenticity_token: found.token,
        'pull_request_review[event]': 'approve',
        'pull_request_review[body]': comment,
      }),
    });

    if (!submitResponse.ok) {
      throw new Error(`approve request failed (${submitResponse.status})`);
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitFor = async (getter, timeout) => {
    const deadline = performance.now() + timeout;
    for (;;) {
      const value = getter();
      if (value) {
        return value;
      }
      if (performance.now() > deadline) {
        return null;
      }
      await sleep(150);
    }
  };

  // fallback that needs no endpoint internals: drive github's own ui - open
  // the review dialog, set the comment and click its submit button
  const submitViaUi = async (comment, pr) => {
    const findOpener = () =>
      [...document.querySelectorAll('button, summary')].find(
        (el) =>
          isSubmitReviewButton(el) && !el.closest(SELECTORS.REVIEW_CONTAINER),
      );

    let opener = findOpener();

    // the conversation tab has no submit review button - go to files changed
    if (!opener) {
      const filesTab = document.querySelector(
        `a[href*="${prPagePath(pr, 'changes')}"], a[href*="${prPagePath(pr, 'files')}"]`,
      );
      filesTab?.click();
      opener = await waitFor(findOpener, 10000);
    }

    if (!opener) {
      throw new Error('submit review button not found on the page');
    }

    opener.click();

    const container = await waitFor(() => findReviewDialogs()[0], 5000);

    if (!container) {
      throw new Error('review dialog did not open');
    }

    const approveRadio = [
      ...container.querySelectorAll(SELECTORS.REVIEW_RADIOS),
    ].find(isApprove);

    if (approveRadio && !approveRadio.checked) {
      approveRadio.click();
    }

    insertAutoComment(getReviewTextarea(container), comment);
    await sleep(200);

    const submitButton =
      [...container.querySelectorAll('button')].find(isSubmitReviewButton) ??
      container.querySelector('[type="submit"]');

    if (!submitButton) {
      throw new Error('submit button not found in the review dialog');
    }

    const enabled = await waitFor(() => !submitButton.disabled, 3000);
    if (!enabled) {
      throw new Error('submit button never became enabled');
    }
    submitButton.click();

    // the dialog going away is the sign the review was submitted
    const closed = await waitFor(() => !document.contains(container), 8000);
    if (!closed) {
      throw new Error('review dialog did not close after submit');
    }
  };

  // ===== PR STATE =====

  // PRs approved through the button in this session; on later visits the
  // page/fetch detection below recognizes the approval instead
  const approvedPrs = new Set();

  // the pr states a header badge can show: data-status "pullMerged" /
  // "pullClosed" / "pullOpened" / "pullDraft" in the react header, the
  // badge text or a "Status: Merged" title on the classic one
  const PR_BADGE_STATES = ['merged', 'closed', 'open', 'draft'];

  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const getMyLogin = () =>
    document.querySelector('meta[name="user-login"]')?.content;

  // read the pr state out of a document: the merged/closed badge in the
  // header, or an "approved these changes" entry for the logged-in user in
  // the sidebar/timeline. null when the document shows neither
  // returns { state, via } or null; `via` names the signal for the log
  const detectPrStateInDoc = (doc, me) => {
    // only the pr header badge counts, and it comes first in the document.
    // timeline cross-references ("this was referenced by #250") and linked
    // issues render their own "Merged"/"Closed" badges further down, which
    // must not hide the button on an open pr - so the first badge that
    // reads as a pr state decides, and an "open"/"draft" header ends the scan
    for (const badge of doc.querySelectorAll(SELECTORS.STATE_BADGE)) {
      const status = (badge.getAttribute('data-status') ?? '').toLowerCase();
      const text = badge.textContent.trim().toLowerCase();
      const title = (badge.getAttribute('title') ?? '').toLowerCase();

      const state = PR_BADGE_STATES.find(
        (name) =>
          status.includes(name) || text === name || title === `status: ${name}`,
      );

      if (!state) {
        continue;
      }

      const via = `state badge "${status || title || text}"`;
      if (state === 'merged' || state === 'closed') {
        return { state, via };
      }
      break; // open or draft header - the pr is open, ignore later badges
    }

    if (me) {
      // my own pr - github forbids approving it, so no button on it.
      // classic pages mark the header author with rel="author" (verified:
      // exactly one per page); the react header renders
      // "<a href=/author>author</a> wants to merge ..."
      const relAuthor = doc.querySelector('a[rel="author"]');
      const wantsToMerge = new RegExp(
        `^\\s*${escapeRegExp(me)}\\b[\\s\\S]{0,10}?wants to merge`,
        'i',
      );
      const isOwn =
        relAuthor?.getAttribute('href') === `/${me}` ||
        [...doc.querySelectorAll(`a[href="/${me}"]`)].some((link) => {
          const text = link.parentElement?.textContent ?? '';
          return text.length <= 300 && wantsToMerge.test(text);
        });

      if (isOwn) {
        return { state: 'own', via: 'pr author' };
      }

      // reviewers sidebar renders one <a id="review-status-<login>"> per
      // reviewer, with an octicon inside encoding the verdict - the check
      // icon means approved (verified markup). a pending request renders a
      // different icon, so it stays "open"
      const myReviewStatus = doc.getElementById(`review-status-${me}`);
      if (myReviewStatus?.querySelector('.octicon-check')) {
        return { state: 'approved', via: 'sidebar icon' };
      }

      // a tooltip or timeline entry whose OWN text starts with
      // "<me> approved these changes" - anchored, so another reviewer's
      // approval can never match; long texts are containers, skip them
      const approvedByMe = new RegExp(
        `^\\s*${escapeRegExp(me)}\\b[\\s\\S]{0,10}?approved these changes`,
        'i',
      );

      for (const item of doc.querySelectorAll(SELECTORS.REVIEW_APPROVAL_TEXT)) {
        const label = item.getAttribute('aria-label') ?? '';
        const text = item.textContent;

        if (
          approvedByMe.test(label) ||
          (text.length <= 200 && approvedByMe.test(text))
        ) {
          return {
            state: 'approved',
            via: `text "${(label || text).trim().slice(0, 120)}"`,
          };
        }
      }
    }

    return null;
  };

  const prStateCache = new Map(); // prKey -> merged|closed|own|approved|open
  // prKeys whose conversation-page fetch was already started - one fetch
  // per pr, its result lands in prStateCache (entries are never removed)
  const prStateFetches = new Set();

  // what to show for this pr: merged/closed/own hide the button, approved
  // shows the passive indicator, open shows the button. layered: our own recorded
  // approvals, then the live page, then (from other tabs) one cached fetch
  // of the conversation page. unknown always falls open to the button
  const getPrDisplayState = (pr) => {
    const key = prKey(pr);

    if (approvedPrs.has(key)) {
      return 'approved';
    }

    const cached = prStateCache.get(key);
    if (cached) {
      return cached;
    }

    const liveDetection = detectPrStateInDoc(document, getMyLogin());
    if (liveDetection) {
      prStateCache.set(key, liveDetection.state);
      console.log(
        `[GitHub PR Approve Helper] pr state: ${liveDetection.state} (live page, via ${liveDetection.via})`,
      );
      return liveDetection.state;
    }

    // the conversation tab shows every signal - nothing found means open
    if (location.pathname === prPagePath(pr)) {
      prStateCache.set(key, 'open');
      return 'open';
    }

    // other tabs lack the sidebar/timeline - ask the conversation page once
    if (!prStateFetches.has(key)) {
      prStateFetches.add(key);
      fetch(prPagePath(pr), { credentials: 'include' })
        .then((response) => (response.ok ? response.text() : null))
        .then((html) => {
          const detection = html
            ? detectPrStateInDoc(
                new DOMParser().parseFromString(html, 'text/html'),
                getMyLogin(),
              )
            : null; // fetch failed - fail open
          const state = detection?.state ?? 'open';
          prStateCache.set(key, state);
          console.log(
            `[GitHub PR Approve Helper] pr state: ${state} (conversation page${
              detection ? `, via ${detection.via}` : ''
            })`,
          );
          scheduleScan();
        })
        .catch(() => prStateCache.set(key, 'open'));
    }

    return 'open'; // fail open while the fetch resolves
  };

  // ===== STACKS =====

  // the stack badge in the pr header ("2/3" with a layers icon, next to the
  // state label) - it opens the stack map popover. its text gives the
  // position and size without opening anything
  const getStackBadge = () => {
    for (const el of document.querySelectorAll('button, summary, a')) {
      const match = el.textContent.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
      // must sit next to the pr state label, so a "1/2" elsewhere on the
      // page (a checks counter, pagination) is never taken for the badge
      const nearStateLabel = el.parentElement
        ?.closest('*')
        ?.parentElement?.querySelector(SELECTORS.STATE_BADGE);
      if (match && el.querySelector('svg') && nearStateLabel) {
        return { el, position: Number(match[1]), size: Number(match[2]) };
      }
    }
    return null;
  };

  // walk the json payloads github embeds in the page for the pr's stack:
  // graphql-shaped `stack: { number, size, entries: [{ position,
  // pullRequest: { number } }] }`, tolerant to flattened entries or an
  // `edges/nodes` connection. returns [{ number, position }] or []
  const collectStackFromPayload = (doc, pr) => {
    const entries = new Map(); // pr number -> position

    const collectEntries = (node, position, depth) => {
      if (!node || typeof node !== 'object' || depth > 8) {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item) => collectEntries(item, position, depth + 1));
        return;
      }
      const ownPosition = Number.isInteger(node.position) ? node.position : position;
      const isPr =
        Number.isInteger(node.number) &&
        !('size' in node) &&
        !('entries' in node) &&
        (typeof node.title === 'string' ||
          'headRefName' in node ||
          'headRef' in node ||
          Number.isInteger(ownPosition));
      if (isPr) {
        entries.set(node.number, ownPosition ?? entries.get(node.number) ?? null);
      }
      for (const value of Object.values(node)) {
        collectEntries(value, ownPosition, depth + 1);
      }
    };

    // find every object that sits under a key named like "stack"
    const findStacks = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 12) {
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (/stack/i.test(key) && value && typeof value === 'object') {
          collectEntries(value, undefined, 0);
        }
        findStacks(value, depth + 1);
      }
    };

    for (const script of doc.querySelectorAll('script[type="application/json"]')) {
      if (/stack/i.test(script.textContent)) {
        findStacks(safeJsonParse(script.textContent), 0);
      }
    }

    // a real stack of this pr contains this pr
    if (!entries.has(Number(pr.number))) {
      return [];
    }
    return [...entries].map(([number, position]) => ({ number, position }));
  };

  // fallback: read the stack map popover ("Stack #257" listing "#255 ·
  // branch" rows). opens it through the badge when closed, and closes it
  // again with escape
  const collectStackFromPopover = async (pr, badge) => {
    const prefix = `/${pr.owner}/${pr.repo}/pull/`;
    const findPopover = () =>
      [...document.querySelectorAll('[role="dialog"], [data-component="Popover"], [class*="Overlay" i], dialog, div')].find(
        (el) =>
          /^\s*Stack #\d+/.test(el.textContent) &&
          el.textContent.length < 5000 &&
          el.querySelector(`a[href*="${prefix}"]`),
      );

    let popover = findPopover();
    let opened = false;
    if (!popover && badge) {
      badge.el.click();
      opened = true;
      popover = await waitFor(findPopover, 3000);
    }
    if (!popover) {
      return [];
    }

    const numbers = [];
    for (const link of popover.querySelectorAll(`a[href*="${prefix}"]`)) {
      const number = Number(link.getAttribute('href').split(prefix)[1]?.match(/^\d+/)?.[0]);
      if (number && !numbers.includes(number)) {
        numbers.push(number);
      }
    }

    if (opened) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      popover.querySelector('button[aria-label*="close" i]')?.click();
    }

    // the popover lists top of the stack first - flip to bottom-first
    return numbers.reverse().map((number, index) => ({ number, position: index + 1 }));
  };

  // the prs of this pr's stack, bottom (closest to the trunk) first
  const findStackPrs = async (pr, badge) => {
    let entries = collectStackFromPayload(document, pr);
    let via = 'page payload';

    if (entries.length < 2) {
      entries = await collectStackFromPopover(pr, badge);
      via = 'stack popover';
    }

    entries.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    console.log(
      `[GitHub PR Approve Helper] stack of ${prKey(pr)}: ${
        entries.map((e) => `#${e.number}`).join(', ') || 'not found'
      } (via ${via})`,
    );
    return entries.map((entry) => ({ ...pr, number: String(entry.number) }));
  };

  // state of another pr of the stack, from its conversation page - so the
  // stack run skips merged/closed/own/already-approved prs instead of
  // failing on them
  const fetchPrState = async (pr) => {
    const response = await fetch(prPagePath(pr), { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`pr page failed to load (${response.status})`);
    }
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    return detectPrStateInDoc(doc, getMyLogin())?.state ?? 'open';
  };

  // per-pr dismissal of the indicator, so a click hides it until the next
  // navigation to a different pr
  let indicatorDismissedFor = null;

  const createApprovedIndicator = (key) => {
    // a real button, so dismissing works with the keyboard too
    const badge = document.createElement('button');
    badge.id = INDICATOR_ID;
    badge.type = 'button';
    badge.textContent = '👍 Already approved';
    badge.title = 'You already approved this PR - click to hide';
    badge.style.cssText = [
      'position: fixed',
      'bottom: 16px',
      'right: 16px',
      'padding: 6px 12px',
      'background: #eaeef2',
      'color: #57606a',
      'font: 600 12px -apple-system, sans-serif',
      'border: 1px solid #d0d7de',
      'border-radius: 6px',
      'cursor: pointer',
      'z-index: 2147483647',
    ].join(';');
    badge.addEventListener('click', () => {
      indicatorDismissedFor = key;
      badge.remove();
    });
    return badge;
  };

  // state: 'busy' | 'done' | 'error', or null when back to idle
  const setButtonState = (button, text, background, state) => {
    button.textContent = text;
    button.style.background = background;

    if (state) {
      button.setAttribute(BUTTON_STATE_ATTRIBUTE, state);
    } else {
      button.removeAttribute(BUTTON_STATE_ATTRIBUTE);
    }
  };

  const closeQuickApproveMenu = () =>
    document.getElementById(MENU_ID)?.remove();

  // approve the whole stack, bottom to top. the current pr may fall back
  // to driving the ui; the others are approved directly or reported
  const approveStack = async (comment, pr, button) => {
    const prs = await findStackPrs(pr, getStackBadge());
    if (prs.length < 2) {
      throw new Error('could not read the stack - see the "stack of" console line');
    }

    const results = { approved: [], skipped: [], failed: [] };

    for (const [index, member] of prs.entries()) {
      setButtonState(button, `⏳ Approving ${index + 1}/${prs.length}…`, '#9a6700', 'busy');
      const key = prKey(member);
      const isCurrent = member.number === pr.number;

      try {
        const state = isCurrent ? 'open' : await fetchPrState(member);
        if (state !== 'open') {
          results.skipped.push(`${key} (${state})`);
          continue;
        }

        try {
          await submitApproval(comment, member);
        } catch (directError) {
          if (!isCurrent) {
            throw directError;
          }
          console.log(
            `[GitHub PR Approve Helper] direct approve failed (${directError.message}), driving the ui instead`,
          );
          await submitViaUi(comment, member);
        }
        approvedPrs.add(key);
        results.approved.push(key);
      } catch (error) {
        results.failed.push(`${key} (${error.message})`);
      }
    }

    console.log(`[GitHub PR Approve Helper] stack run: ${JSON.stringify(results)}`);
    return results;
  };

  const onQuickApprove = async (comment, { stack = false } = {}) => {
    closeQuickApproveMenu();
    const button = document.getElementById(BUTTON_ID);
    const pr = parsePrPath();

    if (!button || !pr) {
      return;
    }

    // ignore a second trigger (e.g. via the right-click menu) while an
    // approval is in flight or its success is still showing
    const state = button.getAttribute(BUTTON_STATE_ATTRIBUTE);
    if (state === 'busy' || state === 'done') {
      return;
    }

    button.disabled = true;
    setButtonState(button, '⏳ Approving…', '#9a6700', 'busy');

    try {
      if (stack) {
        const { approved, skipped, failed } = await approveStack(comment, pr, button);
        const total = approved.length + skipped.length + failed.length;
        if (failed.length) {
          throw new Error(
            `approved ${approved.length}/${total} of the stack, failed: ${failed.join('; ')}`,
          );
        }
        setButtonState(
          button,
          `🎉 Stack approved ${approved.length}/${total}${skipped.length ? ` (${skipped.length} skipped)` : ''}`,
          '#1f883d',
          'done',
        );
      } else {
        try {
          await submitApproval(comment, pr);
        } catch (directError) {
          console.log(
            `[GitHub PR Approve Helper] direct approve failed (${directError.message}), driving the ui instead`,
          );
          await submitViaUi(comment, pr);
        }
        approvedPrs.add(prKey(pr));
        setButtonState(button, '🎉 Approved', '#1f883d', 'done');
      }
      console.log(`[GitHub PR Approve Helper] approved ${prKey(pr)}${stack ? ' (stack)' : ''}: "${comment}"`);
      setTimeout(() => {
        button.remove();
        scheduleScan(); // hands over to the "already approved" indicator
      }, 4000);
    } catch (error) {
      setButtonState(button, '❌ Approve failed - see console', '#cf222e', 'error');
      button.disabled = false;
      console.log(`[GitHub PR Approve Helper] quick approve failed: ${error.message}`);
      setTimeout(
        () => setButtonState(button, '✅ Quick approve', '#1f883d', null),
        4000,
      );
    }
  };

  const createMenuRow = (text, onClick, muted = false) => {
    const row = document.createElement('div');
    row.textContent = text;
    row.style.cssText = [
      'padding: 6px 10px',
      'border-radius: 6px',
      'cursor: pointer',
      `color: ${muted ? '#656d76' : 'inherit'}`,
    ].join(';');
    row.addEventListener('mouseenter', () => (row.style.background = '#f6f8fa'));
    row.addEventListener('mouseleave', () => (row.style.background = ''));
    row.addEventListener('click', onClick);
    return row;
  };

  const toggleQuickApproveMenu = () => {
    if (document.getElementById(MENU_ID)) {
      closeQuickApproveMenu();
      return;
    }

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.cssText = [
      'position: fixed',
      'bottom: 56px',
      'right: 16px',
      'min-width: 220px',
      'padding: 4px',
      'background: #fff',
      'color: #1f2328',
      'font: 13px -apple-system, sans-serif',
      'border: 1px solid #d0d7de',
      'border-radius: 8px',
      'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2)',
      'z-index: 2147483647',
    ].join(';');

    const comments = [
      DEFAULT_COMMENT,
      ...APPROVE_COMMENTS.filter((comment) => comment !== DEFAULT_COMMENT),
    ];

    for (const comment of comments) {
      menu.appendChild(createMenuRow(`✅ ${comment}`, () => onQuickApprove(comment)));
    }
    const badge = STACK_APPROVE && getStackBadge();
    if (badge) {
      const divider = document.createElement('div');
      divider.style.cssText = 'border-top: 1px solid #d0d7de; margin: 4px 0';
      menu.appendChild(divider);
      menu.appendChild(
        createMenuRow(`🥞 Approve whole stack (${badge.size} PRs) with ${DEFAULT_COMMENT}`, () =>
          onQuickApprove(DEFAULT_COMMENT, { stack: true }),
        ),
      );
    }

    menu.appendChild(createMenuRow('Cancel', closeQuickApproveMenu, true));

    document.body.appendChild(menu);
  };

  const ensureQuickApproveButton = () => {
    const pr = parsePrPath();
    const existing = document.getElementById(BUTTON_ID);
    const indicator = document.getElementById(INDICATOR_ID);
    const state =
      SHOW_QUICK_APPROVE && pr && isAllowedOrgPage()
        ? getPrDisplayState(pr)
        : null;

    // a button in a non-idle state is approving or showing its result -
    // its own timeout ends that, don't yank it mid-feedback
    const removableButton =
      existing && !existing.hasAttribute(BUTTON_STATE_ATTRIBUTE);

    if (state !== 'open') {
      if (removableButton) {
        existing.remove();
        closeQuickApproveMenu();
      }

      if (state === 'approved') {
        // passive indicator instead of the button - approving again from
        // here would be a double approve
        if (!indicator && !existing && indicatorDismissedFor !== prKey(pr)) {
          document.body.appendChild(createApprovedIndicator(prKey(pr)));
        }
      } else {
        // merged/closed pr, or not a pr page at all: no widget
        indicator?.remove();
      }
      return;
    }

    indicator?.remove();

    if (existing) {
      return;
    }

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '✅ Quick approve';
    button.title = `Approve Helper v${VERSION} - click: approve with ${DEFAULT_COMMENT} · right-click: choose text or approve the whole stack`;
    button.style.cssText = [
      'position: fixed',
      'bottom: 16px',
      'right: 16px',
      'padding: 8px 14px',
      'background: #1f883d',
      'color: #fff',
      'font: 600 12px -apple-system, sans-serif',
      'border: none',
      'border-radius: 6px',
      'box-shadow: 0 3px 12px rgba(0, 0, 0, 0.3)',
      'cursor: pointer',
      'z-index: 2147483647',
    ].join(';');
    // click approves immediately with the default comment, right-click
    // opens the menu to approve with a different text
    button.addEventListener('click', () => onQuickApprove(DEFAULT_COMMENT));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      toggleQuickApproveMenu();
    });

    document.body.appendChild(button);
  };

  const processReviewContainers = () => {
    if (!isPullRequestPage() || !isAllowedOrgPage()) {
      return;
    }

    for (const container of findReviewDialogs()) {
      if (!container.querySelector(`#${DROPDOWN_ID}`)) {
        // anchor the absolutely-positioned dropdown to the dialog itself
        if (getComputedStyle(container).position === 'static') {
          container.style.position = 'relative';
        }
        container.appendChild(createCommentDropdown());
      }

      // once per dialog open: select approve (github opens with the last
      // used option, and a pre-selected radio fires no change event)
      if (!container.hasAttribute(SEEN_ATTRIBUTE)) {
        container.setAttribute(SEEN_ATTRIBUTE, 'true');
        const approveRadio = [
          ...container.querySelectorAll(SELECTORS.REVIEW_RADIOS),
        ].find(isApprove);

        if (!approveRadio) {
          continue;
        }

        if (AUTO_SELECT_APPROVE && !approveRadio.checked) {
          approveRadio.click();
        }

        if (approveRadio.checked) {
          fillComment(getReviewTextarea(container));
        }
      }
    }
  };

  // the review dialog is created on demand (and react re-creates it on every
  // open), so watch the page and process it whenever it shows up - mutation
  // bursts are coalesced into one scan per animation frame
  let scanScheduled = false;
  const scheduleScan = () => {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      processReviewContainers();
      ensureQuickApproveButton();
    });
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });

  // capture-phase listeners on document survive github's soft navigation
  // and the review dialog being re-created every time it opens
  document.addEventListener('change', onReviewOptionChange, true);
  document.addEventListener('click', onReviewOptionClick, true);

  // close the quick-approve menu on a click elsewhere or on escape
  document.addEventListener(
    'click',
    (event) => {
      if (!getEventTarget(event)?.closest?.(`#${MENU_ID}, #${BUTTON_ID}`)) {
        closeQuickApproveMenu();
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => event.key === 'Escape' && closeQuickApproveMenu(),
    true,
  );

  // the legacy review dropdown stays in the dom when closed (unlike the
  // react dialog, which unmounts): re-arm the once-per-open logic when it
  // closes, and re-process when it opens (open/close mutates no children,
  // so the childList observer alone won't fire)
  document.addEventListener(
    'toggle',
    (event) => {
      const details = getEventTarget(event);
      if (!(details instanceof HTMLDetailsElement)) {
        return;
      }

      if (details.open) {
        scheduleScan();
      } else {
        for (const seen of details.querySelectorAll(`[${SEEN_ATTRIBUTE}]`)) {
          seen.removeAttribute(SEEN_ATTRIBUTE);
        }
      }
    },
    true,
  );

  processReviewContainers();
  ensureQuickApproveButton();
  console.log(`[GitHub PR Approve Helper] v${VERSION} ready on ${location.href}`);
})();
