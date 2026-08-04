// ==UserScript==
// @name         GitHub PR Approve Helper
// @namespace    https://github.com/MishaKav/userscripts/github-pr-approve-helper
// @version      1.1.0
// @description  A userscript that auto-fills the review comment with LGTM when you select Approve in the GitHub pull request review dialog
// @author       Misha Kav
// @copyright    2026, Misha Kav
// @match        https://github.com/*
// @icon         https://github.com/favicon.ico
// @grant        none
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/MishaKav/userscripts/main/github-pr-approve-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/MishaKav/userscripts/main/github-pr-approve-helper.user.js
// @supportURL   https://github.com/MishaKav/userscripts/issues
// ==/UserScript==

(function () {
  'use strict';

  // one of these is picked randomly on every approve, add/remove as you like
  const APPROVE_COMMENTS = ['LGTM', 'LGTM 👍', 'Looks good to me!'];

  // the script only fills comments on PRs of these orgs/users, add as you like
  // (kept as a runtime check instead of @match, so it survives github's
  // soft navigation between orgs)
  const ALLOWED_ORGS = ['linear-b'];

  // marker for text we inserted, so we never delete anything the user typed
  const AUTO_FILL_ATTRIBUTE = 'data-approve-helper-text';

  // 'pull_request_review[event]' - legacy "Review changes" dropdown
  // 'reviewEvent'                - new react "Finish your review" dialog
  const REVIEW_RADIO_NAMES = ['pull_request_review[event]', 'reviewEvent'];

  const SELECTORS = {
    REVIEW_CONTAINER:
      '#review-changes-modal, form[action*="/reviews"], dialog, [role="dialog"]',
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
    el.matches?.('input[type="radio"]') &&
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

    const comment = pickComment();
    setNativeValue(textarea, comment);
    textarea.setAttribute(AUTO_FILL_ATTRIBUTE, comment);
    console.log(`[GitHub PR Approve Helper] filled review comment: "${comment}"`);
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

  const onReviewOptionChange = (event) => {
    const radio = event.target;

    if (
      !isPullRequestPage() ||
      !isAllowedOrgPage() ||
      !isReviewRadio(radio) ||
      !radio.checked
    ) {
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

  // capture-phase listener on document survives github's soft navigation
  // and the review dialog being re-created every time it opens
  document.addEventListener('change', onReviewOptionChange, true);
  console.log('[GitHub PR Approve Helper] ready');
})();
