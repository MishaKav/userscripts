// ==UserScript==
// @name         GitHub PR Approve Helper
// @namespace    https://github.com/MishaKav/userscripts/github-pr-approve-helper
// @version      1.0.0
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
  const VERSION = '1.0.0';

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

  // flash a small badge on PR pages, so it's visible the script is running
  // without opening devtools - set to false to disable
  const SHOW_ACTIVE_BADGE = true;

  const DROPDOWN_ID = 'gpah-comment-select';
  const BADGE_ID = 'gpah-active-badge';
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

  const isPullRequestPage = () => /\/pull\/\d+/.test(location.pathname);

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
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    ).set.call(textarea, text);
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

  const showActiveBadge = () => {
    if (
      !SHOW_ACTIVE_BADGE ||
      !isPullRequestPage() ||
      !isAllowedOrgPage() ||
      document.getElementById(BADGE_ID)
    ) {
      return;
    }

    const badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.textContent = `✅ Approve Helper v${VERSION} active`;
    badge.style.cssText = [
      'position: fixed',
      'bottom: 16px',
      'right: 16px',
      'padding: 6px 12px',
      'background: #1f883d',
      'color: #fff',
      'font: 12px -apple-system, sans-serif',
      'border-radius: 6px',
      'box-shadow: 0 3px 12px rgba(0, 0, 0, 0.3)',
      'pointer-events: none',
      'z-index: 2147483647',
    ].join(';');

    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 2500);
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
  // open), so watch the page and process it whenever it shows up
  const observer = new MutationObserver(processReviewContainers);
  observer.observe(document.body, { childList: true, subtree: true });

  // capture-phase listeners on document survive github's soft navigation
  // and the review dialog being re-created every time it opens
  document.addEventListener('change', onReviewOptionChange, true);
  document.addEventListener('click', onReviewOptionClick, true);
  processReviewContainers();
  showActiveBadge();
  console.log(`[GitHub PR Approve Helper] v${VERSION} ready on ${location.href}`);
})();
