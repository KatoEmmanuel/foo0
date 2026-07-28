/**
 * MarzPay embeddable payment widget for katoemmanganda.com
 *
 * This file NEVER contains an API key or secret, and never calls
 * wallet.wearemarz.com directly. It only calls YOUR backend
 * (see server/server.js), which is the only thing allowed to hold
 * MarzPay credentials.
 *
 * USAGE
 * -----
 * <link rel="stylesheet" href="/payment-widget.css">
 * <script src="/payment-widget.js"></script>
 *
 * <div id="buy-button"></div>
 * <script>
 *   MarzPayWidget.mount('#buy-button', {
 *     backendUrl: 'https://api.katoemmanganda.com',   // your server from server.js
 *     productId: 'example-product-1',                  // preferred: server looks up price
 *     // amount: 25000,                                 // only if you don't use productId
 *     description: 'Order #1024',
 *     buttonLabel: 'Pay now',
 *     onSuccess: (result) => console.log('paid', result),
 *     onFailure: (result) => console.log('failed', result),
 *   });
 * </script>
 */
(function (global) {
  'use strict';

  const POLL_INTERVAL_MS = 3000;
  const POLL_TIMEOUT_MS = 120000; // 2 minutes — mobile money USSD prompts expire around then anyway

  function detectProvider(localDigits) {
    // Cosmetic only — the backend/MarzPay do the real detection. Helps the
    // customer confirm they typed the right number.
    if (/^(70[0-5]|75[0-5]?|7[0-4]\d)\d{6}$/.test(localDigits)) return null; // ambiguous, skip
    if (/^(76|77|78|31|39)\d{7}$/.test(localDigits)) return 'mtn';
    if (/^(70|74|75)\d{7}$/.test(localDigits)) return 'airtel';
    return null;
  }

  function formatUGX(amount) {
    if (amount == null) return '';
    return 'UGX ' + Number(amount).toLocaleString('en-UG');
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    children.flat().forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  class MarzPayWidget {
    constructor(mountEl, opts) {
      if (!opts || !opts.backendUrl) {
        throw new Error('MarzPayWidget: backendUrl is required (point it at your own server, not MarzPay).');
      }
      if (!opts.productId && !opts.amount) {
        throw new Error('MarzPayWidget: pass either productId (recommended) or amount.');
      }
      this.opts = Object.assign(
        {
          buttonLabel: 'Pay now',
          description: 'Payment',
          currencyLabel: formatUGX(opts.amount),
          onSuccess: () => {},
          onFailure: () => {},
        },
        opts
      );
      this.mountEl = mountEl;
      this.method = 'mobile_money';
      this._renderTrigger();
    }

    _renderTrigger() {
      const btn = el(
        'button',
        { class: 'mzp-trigger', type: 'button', onclick: () => this._openModal() },
        this.opts.buttonLabel
      );
      const scope = el('div', { class: 'mzp-scope' }, btn);
      this.mountEl.innerHTML = '';
      this.mountEl.appendChild(scope);
    }

    _openModal() {
      this.reference = null;
      this.pollTimer = null;
      this.pollDeadline = null;

      const overlay = el('div', {
        class: 'mzp-overlay',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'mzp-title',
        onclick: (e) => {
          if (e.target === overlay) this._closeModal();
        },
      });

      const closeBtn = el(
        'button',
        { class: 'mzp-close', 'aria-label': 'Close payment dialog', onclick: () => this._closeModal() },
        '\u00d7'
      );

      const header = el('div', { class: 'mzp-header' }, el('h2', { id: 'mzp-title' }, 'Complete payment'), closeBtn);

      this.bodyEl = el('div', { class: 'mzp-body' });
      const modal = el('div', { class: 'mzp-scope' }, el('div', { class: 'mzp-modal' }, header, this.bodyEl));

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      this.overlayEl = overlay;

      document.addEventListener('keydown', this._onKeydown = (e) => {
        if (e.key === 'Escape') this._closeModal();
      });

      this._renderForm();
      closeBtn.focus();
    }

    _closeModal() {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      if (this.overlayEl) this.overlayEl.remove();
      document.removeEventListener('keydown', this._onKeydown);
    }

    _renderForm(errorMsg) {
      const o = this.opts;
      this.bodyEl.innerHTML = '';

      const amountLine = el('p', { class: 'mzp-amount' }, o.amount ? formatUGX(o.amount) : 'Amount set at checkout');
      const descLine = el('p', { class: 'mzp-desc' }, o.description);

      const tabs = el(
        'div',
        { class: 'mzp-tabs', role: 'tablist' },
        el(
          'button',
          {
            class: 'mzp-tab',
            role: 'tab',
            type: 'button',
            'aria-selected': String(this.method === 'mobile_money'),
            onclick: () => {
              this.method = 'mobile_money';
              this._renderForm();
            },
          },
          'Mobile Money'
        ),
        el(
          'button',
          {
            class: 'mzp-tab',
            role: 'tab',
            type: 'button',
            'aria-selected': String(this.method === 'card'),
            onclick: () => {
              this.method = 'card';
              this._renderForm();
            },
          },
          'Card'
        )
      );

      const form = el('form', { onsubmit: (e) => this._onSubmit(e) });

      if (errorMsg) form.appendChild(el('div', { class: 'mzp-error' }, errorMsg));

      let phoneInput = null;
      let providerBadge = null;

      if (this.method === 'mobile_money') {
        phoneInput = el('input', {
          type: 'tel',
          inputmode: 'numeric',
          autocomplete: 'tel',
          placeholder: '0781234567',
          required: 'required',
          oninput: (e) => {
            const digits = e.target.value.replace(/\D/g, '').replace(/^256/, '').replace(/^0/, '');
            const provider = detectProvider(digits);
            if (provider) {
              providerBadge.textContent = provider.toUpperCase() + ' Mobile Money detected';
              providerBadge.className = 'mzp-provider-badge ' + provider;
              providerBadge.style.display = 'inline-block';
            } else {
              providerBadge.style.display = 'none';
            }
          },
        });
        providerBadge = el('span', { class: 'mzp-provider-badge', style: 'display:none' });

        const field = el(
          'div',
          { class: 'mzp-field' },
          el('label', { for: 'mzp-phone' }, 'Mobile money number'),
          phoneInput,
          el('div', { class: 'mzp-hint' }, "You'll get a prompt on your phone to approve this payment."),
          el('div', {}, providerBadge)
        );
        phoneInput.id = 'mzp-phone';
        form.appendChild(field);
      } else {
        form.appendChild(
          el(
            'div',
            { class: 'mzp-field' },
            el('div', { class: 'mzp-hint' }, "You'll be securely redirected to complete your card payment.")
          )
        );
      }

      const submitBtn = el(
        'button',
        { class: 'mzp-submit', type: 'submit' },
        this.method === 'card' ? 'Continue to card payment' : 'Send payment prompt'
      );

      form.appendChild(submitBtn);
      form.appendChild(
        el('div', { class: 'mzp-secure-note' }, '\ud83d\udd12 Payments are processed securely by MarzPay')
      );

      this._phoneInput = phoneInput;
      this._submitBtn = submitBtn;

      this.bodyEl.appendChild(amountLine);
      this.bodyEl.appendChild(descLine);
      this.bodyEl.appendChild(tabs);
      this.bodyEl.appendChild(form);
    }

    async _onSubmit(e) {
      e.preventDefault();
      const o = this.opts;
      this._submitBtn.disabled = true;
      this._submitBtn.textContent = 'Please wait\u2026';

      const payload = {
        method: this.method,
        product_id: o.productId,
        amount: o.amount,
        description: o.description,
      };
      if (this.method === 'mobile_money') {
        payload.phone_number = this._phoneInput.value.trim();
      }

      try {
        const res = await fetch(o.backendUrl.replace(/\/$/, '') + '/api/payments/collect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (!res.ok || data.status !== 'success') {
          this._renderForm(data.message || 'Payment could not be started. Please try again.');
          return;
        }

        this.reference = data.reference;

        if (this.method === 'card') {
          if (!data.redirect_url) {
            this._renderForm('Could not get a card payment link. Please try again.');
            return;
          }
          window.location.assign(data.redirect_url);
          return;
        }

        this._renderWaiting();
        this._startPolling();
      } catch (err) {
        this._renderForm('Network error. Check your connection and try again.');
      }
    }

    _renderWaiting() {
      this.bodyEl.innerHTML = '';
      this.bodyEl.appendChild(
        el(
          'div',
          { class: 'mzp-status' },
          el('div', { class: 'mzp-spinner' }),
          el('h3', {}, 'Check your phone'),
          el('p', {}, 'Approve the payment prompt sent to your mobile money line.')
        )
      );
    }

    _renderResult(success, message) {
      this.bodyEl.innerHTML = '';
      this.bodyEl.appendChild(
        el(
          'div',
          { class: 'mzp-status ' + (success ? 'mzp-success' : 'mzp-fail') },
          el('div', { class: 'mzp-icon' }, success ? '\u2705' : '\u26a0\ufe0f'),
          el('h3', {}, success ? 'Payment received' : 'Payment not completed'),
          el('p', {}, message)
        )
      );
      if (success) this.opts.onSuccess({ reference: this.reference });
      else this.opts.onFailure({ reference: this.reference });
    }

    _startPolling() {
      this.pollDeadline = Date.now() + POLL_TIMEOUT_MS;
      const poll = async () => {
        if (Date.now() > this.pollDeadline) {
          this._renderResult(false, "We haven't heard back yet. Check your order status page shortly.");
          return;
        }
        try {
          const res = await fetch(
            this.opts.backendUrl.replace(/\/$/, '') + '/api/payments/status/' + this.reference
          );
          const data = await res.json();
          if (data.transaction_status === 'completed') {
            this._renderResult(true, 'Thank you \u2014 your payment was successful.');
            return;
          }
          if (data.transaction_status === 'failed') {
            this._renderResult(false, 'The payment was declined or cancelled.');
            return;
          }
        } catch (_) {
          /* ignore transient errors, keep polling until deadline */
        }
        this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      };
      this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  }

  global.MarzPayWidget = {
    mount(selector, opts) {
      const target = typeof selector === 'string' ? document.querySelector(selector) : selector;
      if (!target) throw new Error('MarzPayWidget: mount target not found: ' + selector);
      return new MarzPayWidget(target, opts);
    },
  };
})(window);
