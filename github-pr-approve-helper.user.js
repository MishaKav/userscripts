// ==UserScript==
// @name         GitHub PR Approve Helper
// @namespace    https://github.com/MishaKav/userscripts/github-pr-approve-helper
// @version      1.2.0
// @description  A userscript that auto-fills the review comment with LGTM when you select Approve in the GitHub pull request review dialog
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
  const VERSION = '1.2.0';

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

  const DROPDOWN_ID = 'gpah-comment-select';
  const BUTTON_ID = 'gpah-quick-approve';
  const MENU_ID = 'gpah-quick-approve-menu';
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
  };

  const parsePrPath = () => {
    const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return match && { owner: match[1], repo: match[2], number: match[3] };
  };

  const prKey = (pr) => `${pr.owner}/${pr.repo}#${pr.number}`;

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

  const fillComment = (textarea) => {
    // never overwrite anything the user already typed
    if (textarea.value.trim() !== '') {
      return;
    }

    setNativeValue(textarea, DEFAULT_COMMENT);
    textarea.setAttribute(AUTO_FILL_ATTRIBUTE, DEFAULT_COMMENT);
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
      setNativeValue(textarea, comment);
      textarea.setAttribute(AUTO_FILL_ATTRIBUTE, comment);
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

  // find a csrf token for the review submit in a document, trying every
  // known place github puts one: the legacy review form, then the
  // csrf_tokens map embedded in the json payloads of the new react pages
  const findReviewToken = (doc, pr) => {
    const form = doc.querySelector('form[action$="/reviews"]');
    const formToken = form?.querySelector(
      'input[name="authenticity_token"]',
    )?.value;

    if (formToken) {
      return { token: formToken, path: form.getAttribute('action') };
    }

    for (const script of doc.querySelectorAll('script[type="application/json"]')) {
      const map = findCsrfTokensMap(safeJsonParse(script.textContent));
      const entry =
        map &&
        Object.entries(map).find(
          ([path]) =>
            path.includes(`/pull/${pr.number}`) && path.endsWith('/reviews'),
        );

      if (entry) {
        const [path, tokens] = entry;
        const token = tokens?.post ?? Object.values(tokens ?? {})[0];
        if (token) {
          return { token, path };
        }
      }
    }

    return null;
  };

  // what was searched, for the console diagnostic when no token is found
  // (paths only, never token values)
  const describeTokenSearch = (doc) => {
    const scripts = [...doc.querySelectorAll('script[type="application/json"]')];
    return {
      jsonScripts: scripts.length,
      reviewForms: doc.querySelectorAll('form[action$="/reviews"]').length,
      csrfTokenPaths: scripts.flatMap((script) =>
        Object.keys(findCsrfTokensMap(safeJsonParse(script.textContent)) ?? {}),
      ),
    };
  };

  // approve the PR the same way github's own ui does: find a fresh csrf
  // token (on the live page, or on the fetched files page) and post the
  // approve to the reviews endpoint with the session cookies
  const submitApproval = async (comment) => {
    const pr = parsePrPath();

    // the page we're already on may embed the token
    let found = findReviewToken(document, pr);
    let filesDoc = null;

    if (!found) {
      const filesUrl = `/${pr.owner}/${pr.repo}/pull/${pr.number}/files`;
      const filesResponse = await fetch(filesUrl, { credentials: 'include' });

      if (!filesResponse.ok) {
        throw new Error(`review form page failed to load (${filesResponse.status})`);
      }

      filesDoc = new DOMParser().parseFromString(
        await filesResponse.text(),
        'text/html',
      );
      found = findReviewToken(filesDoc, pr);
    }

    if (!found) {
      console.log(
        '[GitHub PR Approve Helper] csrf discovery details:',
        JSON.stringify({
          livePage: describeTokenSearch(document),
          filesPage: filesDoc && describeTokenSearch(filesDoc),
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

  // PRs approved through the button this session, so it doesn't re-appear
  const approvedPrs = new Set();

  const setButtonState = (button, text, background) => {
    button.textContent = text;
    button.style.background = background;
  };

  const closeQuickApproveMenu = () =>
    document.getElementById(MENU_ID)?.remove();

  const onQuickApprove = async (comment) => {
    closeQuickApproveMenu();
    const button = document.getElementById(BUTTON_ID);
    const pr = parsePrPath();

    if (!button || !pr) {
      return;
    }

    button.disabled = true;
    setButtonState(button, '⏳ Approving…', '#9a6700');

    try {
      await submitApproval(comment);
      approvedPrs.add(prKey(pr));
      setButtonState(button, '🎉 Approved', '#1f883d');
      console.log(`[GitHub PR Approve Helper] approved ${prKey(pr)}: "${comment}"`);
      setTimeout(() => button.remove(), 4000);
    } catch (error) {
      setButtonState(button, '❌ Approve failed - see console', '#cf222e');
      button.disabled = false;
      console.log(`[GitHub PR Approve Helper] quick approve failed: ${error.message}`);
      setTimeout(() => setButtonState(button, '✅ Quick approve', '#1f883d'), 4000);
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
    menu.appendChild(createMenuRow('Cancel', closeQuickApproveMenu, true));

    document.body.appendChild(menu);
  };

  const ensureQuickApproveButton = () => {
    const pr = parsePrPath();
    const existing = document.getElementById(BUTTON_ID);
    const wanted =
      SHOW_QUICK_APPROVE && pr && isAllowedOrgPage() && !approvedPrs.has(prKey(pr));

    if (!wanted) {
      // a disabled button is approving or showing its result - it removes
      // itself via its own timeout, don't yank it mid-feedback
      if (existing && !existing.disabled) {
        existing.remove();
        closeQuickApproveMenu();
      }
      return;
    }

    if (existing) {
      return;
    }

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '✅ Quick approve';
    button.title = `Approve Helper v${VERSION} - click: approve with ${DEFAULT_COMMENT} · right-click: choose text`;
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

    const containers = document.querySelectorAll(SELECTORS.REVIEW_CONTAINER);

    for (const container of containers) {
      // only real review dialogs (they contain the approve/comment radios)
      const radios = [...container.querySelectorAll(SELECTORS.REVIEW_RADIOS)];
      const textarea = radios.length > 0 && getReviewTextarea(container);

      if (!textarea) {
        continue;
      }

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
        const approveRadio = radios.find(isApprove);

        if (!approveRadio) {
          continue;
        }

        if (AUTO_SELECT_APPROVE && !approveRadio.checked) {
          approveRadio.click();
        }

        if (approveRadio.checked) {
          fillComment(textarea);
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

  processReviewContainers();
  ensureQuickApproveButton();
  console.log(`[GitHub PR Approve Helper] v${VERSION} ready on ${location.href}`);
})();
