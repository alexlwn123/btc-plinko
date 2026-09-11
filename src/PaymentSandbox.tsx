import { Checkout, useCheckout, useCheckoutSuccess } from "@moneydevkit/core/client";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import "./paymentSandbox.css";

function CreateCheckout() {
  const [amount, setAmount] = useState("1000");
  const { createCheckout, isLoading, error } = useCheckout();

  return (
    <section className="signet-form">
      <h1>Signet checkout</h1>
      <p>Testnet funds only. No game credits or withdrawals.</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await createCheckout({
            type: "AMOUNT",
            currency: "SAT",
            amount: Number(amount),
            title: "Signet test payment",
            checkoutPath: "/sandbox/checkout",
            successUrl: "/sandbox/success",
          });
          if (result.data) window.location.href = result.data.checkoutUrl;
        }}
      >
        <label htmlFor="signet-amount">Amount (Signet sats)</label>
        <input
          id="signet-amount"
          type="number"
          min="1"
          step="1"
          required
          value={amount}
          disabled={isLoading}
          onChange={(event) => setAmount(event.target.value)}
        />
        <button type="submit" disabled={isLoading}>
          {isLoading ? "Creating checkout..." : "Create checkout"}
        </button>
        {error && <p role="alert">{error.message}</p>}
      </form>
    </section>
  );
}

function CheckoutSuccess() {
  const { isCheckoutPaid, isCheckoutPaidLoading } = useCheckoutSuccess();
  return (
    <section className="signet-form">
      <h1>Signet payment</h1>
      <p role="status">
        {isCheckoutPaidLoading
          ? "Checking payment status..."
          : isCheckoutPaid
            ? "Payment confirmed by Money Dev Kit."
            : "Payment has not been confirmed."}
      </p>
      <a href="/sandbox">New checkout</a>
    </section>
  );
}

export default function PaymentSandbox() {
  const path = window.location.pathname;
  const checkoutId = path.startsWith("/sandbox/checkout/")
    ? path.slice("/sandbox/checkout/".length)
    : undefined;

  return (
    <main className="signet-page">
      <header className="signet-header">
        <a href={checkoutId || path === "/sandbox/success" ? "/sandbox" : "/"}>
          <ArrowLeft size={18} /> Back
        </a>
        <span>Signet / Mutinynet</span>
      </header>
      {checkoutId ? (
        <Checkout id={checkoutId} theme="light" />
      ) : path === "/sandbox/success" ? (
        <CheckoutSuccess />
      ) : (
        <CreateCheckout />
      )}
    </main>
  );
}
