import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, supabaseConfigError } from "./supabase";
import "./App.css";

const nairaFormatter = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const transactionDateFormatter = new Intl.DateTimeFormat("en-NG", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatNaira(amount) {
  const numericAmount = Number(amount);
  return Number.isFinite(numericAmount) ? nairaFormatter.format(numericAmount) : "₦ —";
}

const navigation = [
  { id: "dashboard", label: "Dashboard", icon: "grid" },
  { id: "airtime", label: "Airtime", icon: "phone" },
  { id: "data", label: "Data", icon: "wifi" },
  { id: "bills", label: "Bills", icon: "receipt" },
  { id: "history", label: "History", icon: "clock" },
  { id: "wallet", label: "Wallet", icon: "wallet" },
];

const mobileNavigation = navigation.filter((item) => item.id !== "history");

const services = [
  {
    id: "airtime",
    label: "Buy airtime",
    description: "Top up any network",
    icon: "phone",
    color: "blue",
  },
  {
    id: "data",
    label: "Buy data",
    description: "Browse without limits",
    icon: "wifi",
    color: "purple",
  },
  {
    id: "bills",
    label: "Pay a bill",
    description: "Utilities and more",
    icon: "receipt",
    color: "orange",
  },
];

function Icon({ name, size = 20 }) {
  const paths = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    phone: (
      <path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3 15h4" />
    ),
    wifi: (
      <>
        <path d="M5 9a11 11 0 0 1 14 0" />
        <path d="M8 12a6.5 6.5 0 0 1 8 0" />
        <path d="M11 15a2 2 0 0 1 2 0" />
        <path d="M12 19h.01" />
      </>
    ),
    receipt: (
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6" />
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    wallet: (
      <>
        <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19a2 2 0 0 1 2 2v13H6a3 3 0 0 1-3-3V6.5Z" />
        <path d="M3 8h15a2 2 0 0 1 2 2v3h-5a2 2 0 0 1 0-4h5" />
        <path d="M16 11h.01" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    logout: (
      <>
        <path d="M10 17l5-5-5-5" />
        <path d="M15 12H3m9-8h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      </>
    ),
    menu: (
      <>
        <path d="M4 7h16M4 12h16M4 17h16" />
      </>
    ),
    shield: (
      <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
    ),
    spark: (
      <>
        <path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" />
        <path d="m19 14 1 2.5 2 1-2 1L19 21l-1-2.5-2-1 2-1 1-2.5Z" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function Brand({ compact = false }) {
  return (
    <div className={`brand${compact ? " brand-compact" : ""}`}>
      <span className="brand-mark" aria-hidden="true">
        N
      </span>
      <span className="brand-name">
        NUR2 <strong>DATA</strong>
      </span>
    </div>
  );
}

function getDataPlans(response) {
  const plans =
    response?.data?.data_plans ??
    response?.data?.data?.data_plans ??
    response?.data_plans;

  if (!Array.isArray(plans)) {
    throw new Error("The data-plan service returned an unexpected response.");
  }

  return plans;
}

function getPlanValue(plan, keys) {
  if (!plan || typeof plan !== "object") return undefined;
  return keys.map((key) => plan[key]).find((value) =>
    typeof value === "string" || typeof value === "number"
  );
}

function getPlanName(plan, index) {
  return getPlanValue(plan, [
    "plan_name",
    "name",
    "data_plan",
    "plan",
    "title",
  ]) ?? `Data plan ${index + 1}`;
}

function getPlanPrice(plan) {
  const price = getPlanValue(plan, [
    "price",
    "amount",
    "plan_amount",
    "selling_price",
  ]);
  return price === undefined ? "Not provided" : `₦${price}`;
}

function normalizeNigerianPhoneNumber(value) {
  const digits = value.replace(/\D/g, "");
  const localNumber = digits.startsWith("234")
    ? `0${digits.slice(3)}`
    : digits;
  return /^0(?:70|80|81|90|91)\d{8}$/.test(localNumber)
    ? `+234${localNumber.slice(1)}`
    : null;
}

function redactSensitiveText(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(
      /((?:api[_ -]?key|token|authorization|secret|password|credential|jwt)\s*[:=]\s*)[^\s,;"']+/gi,
      "$1[REDACTED]",
    );
}

function redactSensitiveData(value) {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveData);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /api.?key|token|authorization|secret|password|credential|jwt/i.test(key)
          ? "[REDACTED]"
          : redactSensitiveData(item),
      ]),
    );
  }

  return typeof value === "string" ? redactSensitiveText(value) : value;
}

async function getFunctionErrorDetails(error) {
  const response =
    error?.context instanceof Response
      ? error.context
      : error?.response instanceof Response
        ? error.response
        : null;
  const status = response?.status ?? error?.context?.status ?? error?.status;
  let responseBody = "";

  if (response) {
    try {
      const bodyText = await response.clone().text();
      if (bodyText) {
        try {
          responseBody = JSON.stringify(
            redactSensitiveData(JSON.parse(bodyText)),
            null,
            2,
          );
        } catch {
          responseBody = redactSensitiveText(bodyText);
        }
        if (responseBody.length > 4000) {
          responseBody = `${responseBody.slice(0, 4000)}\n[Response truncated]`;
        }
      }
    } catch {
      responseBody = "The response body could not be read.";
    }
  }

  let parsedBody;
  try {
    parsedBody = responseBody ? JSON.parse(responseBody) : null;
  } catch {
    parsedBody = null;
  }
  const bodyText = typeof parsedBody === "string" ? parsedBody : responseBody;
  const providerError =
    typeof parsedBody?.error === "string" ? parsedBody.error : "";
  const gatewayMessage =
    typeof parsedBody?.message === "string" ? parsedBody.message : bodyText;
  const isVtuGateError = /vtugate/i.test(providerError || bodyText);
  const isGatewayJwtError =
    !isVtuGateError &&
    status === 401 &&
    /invalid jwt|invalid token|protected header|missing authorization header/i.test(
      gatewayMessage,
    );

  let message;
  if (isVtuGateError) {
    message = `VTUGate returned an error${status ? ` (HTTP ${status})` : ""}.`;
  } else if (isGatewayJwtError) {
    message = `Supabase rejected the function request's JWT (HTTP ${status}).`;
  } else if (status === 401) {
    message =
      "fetchdataplans returned HTTP 401, but the response does not identify which service rejected it.";
  } else if (status) {
    message = `The fetchdataplans Edge Function returned HTTP ${status}.`;
  } else {
    message = "Unable to reach the fetchdataplans Edge Function.";
  }

  return { message, responseBody };
}

function DataPlansPanel() {
  const networks = ["MTN", "Airtel", "Glo", "9mobile"];
  const [network, setNetwork] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [plans, setPlans] = useState(null);
  const [selectedPlanIndex, setSelectedPlanIndex] = useState(null);
  const [confirmationVisible, setConfirmationVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [errorDetails, setErrorDetails] = useState("");

  const selectedPlan =
    selectedPlanIndex === null ? null : plans?.[selectedPlanIndex] ?? null;
  const normalizedPhoneNumber = normalizeNigerianPhoneNumber(phoneNumber);

  async function loadPlans(event) {
    event?.preventDefault();
    const normalizedServiceId = serviceId.trim();
    if (!network) {
      setErrorMessage("Choose a network before loading data plans.");
      return;
    }
    if (!normalizedPhoneNumber) {
      setErrorMessage(
        "Enter a valid Nigerian mobile number, such as 08012345678 or +2348012345678.",
      );
      return;
    }
    if (!normalizedServiceId) {
      setErrorMessage("Enter the VTUGate service ID for the selected network.");
      return;
    }

    setLoading(true);
    setErrorMessage("");
    setErrorDetails("");
    setPlans(null);
    setSelectedPlanIndex(null);
    setConfirmationVisible(false);

    try {
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession();
      if (sessionError) {
        throw new Error("We couldn't verify your login. Please sign in again.");
      }

      let session = sessionData.session;
      if (!session?.access_token?.trim() || !session.user?.id) {
        throw new Error("Your session is missing or expired. Please sign in again.");
      }

      if (
        typeof session.expires_at === "number" &&
        session.expires_at <= Math.floor(Date.now() / 1000)
      ) {
        const { data: refreshedSession, error: refreshError } =
          await supabase.auth.refreshSession();
        if (
          refreshError ||
          !refreshedSession.session?.access_token?.trim() ||
          !refreshedSession.session.user?.id
        ) {
          throw new Error("Your session has expired. Please sign in again.");
        }
        session = refreshedSession.session;
      }

      const { data, error } = await supabase.functions.invoke("fetchdataplans", {
        body: { service_id: normalizedServiceId },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error) {
        const details = await getFunctionErrorDetails(error);
        setErrorMessage(details.message);
        setErrorDetails(details.responseBody);
        return;
      }
      if (typeof data?.error === "string") throw new Error(data.error);

      setPlans(getDataPlans(data));
      setErrorDetails("");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to load data plans. Please try again.",
      );
      setErrorDetails("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="content-card service-panel data-plans-panel">
      <span className="service-icon service-icon-purple">
        <Icon name="wifi" size={24} />
      </span>
      {!confirmationVisible ? (
        <>
          <span className="eyebrow">AVAILABLE DATA PLANS</span>
          <h2>Choose a data plan</h2>
          <p>Select your network and enter your details to view available plans.</p>

          <form className="data-plan-form" onSubmit={loadPlans}>
            <label htmlFor="data-network">Network</label>
            <select
              id="data-network"
              value={network}
              onChange={(event) => {
                setNetwork(event.target.value);
                setPlans(null);
                setSelectedPlanIndex(null);
                setErrorMessage("");
                setErrorDetails("");
              }}
              required
              disabled={loading}
            >
              <option value="">Select network</option>
              {networks.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>

            <label htmlFor="data-phone-number">Nigerian phone number</label>
            <input
              id="data-phone-number"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              placeholder="08012345678"
              aria-describedby="data-phone-help"
              required
              disabled={loading}
            />
            <small id="data-phone-help" className="data-plan-help">
              Enter an 11-digit Nigerian number or use the +234 country code.
            </small>

            <label htmlFor="data-service-id">VTUGate service ID</label>
            <input
              id="data-service-id"
              type="text"
              autoComplete="off"
              value={serviceId}
              onChange={(event) => {
                setServiceId(event.target.value);
                setPlans(null);
                setSelectedPlanIndex(null);
                setErrorMessage("");
                setErrorDetails("");
              }}
              placeholder="Enter service ID for this network"
              required
              disabled={loading}
            />
            <p className="data-plan-help">
              Use the service ID supplied by your VTUGate service catalog.
            </p>
            <button className="primary-button data-plan-load-button" type="submit" disabled={loading}>
              {loading ? "Loading plans..." : "Load plans"}
            </button>
          </form>

          {loading && (
            <p className="data-plan-state" role="status">Loading available data plans...</p>
          )}

          {errorMessage && (
            <div className="data-plan-error" role="alert">
              <div className="data-plan-error-copy">
                <p>{errorMessage}</p>
                {errorDetails && (
                  <details className="data-plan-error-details">
                    <summary>View safe error response</summary>
                    <pre>{errorDetails}</pre>
                  </details>
                )}
              </div>
              <button className="text-button" type="button" onClick={loadPlans} disabled={loading}>
                Retry
              </button>
            </div>
          )}

          {plans && !loading && (
            plans.length ? (
              <>
                <div className="data-plan-list" aria-label="Available data plans">
                  {plans.map((plan, index) => {
                    const name = getPlanName(plan, index);
                    const validity = getPlanValue(plan, [
                      "validity",
                      "duration",
                      "valid_for",
                    ]);
                    return (
                      <button
                        className={`data-plan-card${selectedPlanIndex === index ? " data-plan-card-selected" : ""}`}
                        key={plan?.id ?? `${index}-${name}`}
                        type="button"
                        aria-pressed={selectedPlanIndex === index}
                        onClick={() => setSelectedPlanIndex(index)}
                      >
                        <strong>{name}</strong>
                        <span>Price: {getPlanPrice(plan)}</span>
                        {validity !== undefined && <span>Validity: {validity}</span>}
                      </button>
                    );
                  })}
                </div>
                {selectedPlan && (
                  <div className="data-plan-summary">
                    <h3>Purchase summary</h3>
                    <dl>
                      <div><dt>Network</dt><dd>{network}</dd></div>
                      <div><dt>Phone number</dt><dd>{normalizedPhoneNumber ?? "Enter a valid Nigerian number"}</dd></div>
                      <div><dt>Plan</dt><dd>{getPlanName(selectedPlan, selectedPlanIndex)}</dd></div>
                      <div><dt>Price</dt><dd>{getPlanPrice(selectedPlan)}</dd></div>
                    </dl>
                    <button
                      className="primary-button data-plan-continue-button"
                      type="button"
                      disabled={!normalizedPhoneNumber}
                      onClick={() => setConfirmationVisible(true)}
                    >
                      Continue
                    </button>
                    <p className="data-plan-no-purchase">
                      This is a review only. No purchase will be made.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p className="data-plan-state" role="status">
                No data plans are available for this service ID.
              </p>
            )
          )}
        </>
      ) : (
        <div className="data-plan-confirmation" role="status">
          <span className="eyebrow">CONFIRMATION</span>
          <h2>Your details are ready</h2>
          <p>No purchase has been made. This dashboard does not submit transactions yet.</p>
          <dl>
            <div><dt>Network</dt><dd>{network}</dd></div>
            <div><dt>Phone number</dt><dd>{normalizedPhoneNumber}</dd></div>
            <div><dt>Plan</dt><dd>{getPlanName(selectedPlan, selectedPlanIndex)}</dd></div>
            <div><dt>Price</dt><dd>{getPlanPrice(selectedPlan)}</dd></div>
          </dl>
          <button
            className="text-button"
            type="button"
            onClick={() => setConfirmationVisible(false)}
          >
            Back to plans
          </button>
        </div>
      )}
    </section>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      if (mode === "register") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;

        setMessage(
          data.session
            ? "Your account is ready. Welcome to NUR2 DATA!"
            : "Registration successful. Check your email to confirm your account.",
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (error) {
      setMessage(error.message || "We couldn't complete your request. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-aside">
        <Brand />
        <div className="auth-promo">
          <span className="eyebrow">YOUR EVERYDAY DIGITAL WALLET</span>
          <h1>Stay connected.<br />Keep moving.</h1>
          <p>Top up, stay online, and take care of everyday bills in one simple place.</p>
          <div className="promo-note">
            <span className="promo-icon"><Icon name="shield" /></span>
            <span><strong>Simple and secure</strong><small>Your account, always in your hands.</small></span>
          </div>
        </div>
        <p className="auth-copyright">© 2026 NUR2 DATA</p>
      </section>

      <section className="auth-content">
        <div className="auth-mobile-brand"><Brand compact /></div>
        <div className="auth-card">
          <span className="eyebrow">{mode === "login" ? "WELCOME BACK" : "GET STARTED"}</span>
          <h2>{mode === "login" ? "Sign in to your account" : "Create your account"}</h2>
          <p className="auth-description">
            {mode === "login"
              ? "Enter your details to continue to NUR2 DATA."
              : "A few details and you're ready to get started."}
          </p>

          <div className="auth-tabs" role="group" aria-label="Account action">
            <button
              type="button"
              aria-pressed={mode === "login"}
              onClick={() => { setMode("login"); setMessage(""); }}
            >
              Sign in
            </button>
            <button
              type="button"
              aria-pressed={mode === "register"}
              onClick={() => { setMode("register"); setMessage(""); }}
            >
              Create account
            </button>
          </div>

          <form className="auth-form" onSubmit={handleSubmit}>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="At least 6 characters"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <button className="primary-button auth-submit" type="submit" disabled={loading}>
              {loading ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
              {!loading && <Icon name="arrow" size={18} />}
            </button>
          </form>

          {message && <p className="form-message" role="status">{message}</p>}
          <p className="auth-terms">By continuing, you agree to use NUR2 DATA responsibly.</p>
        </div>
        <p className="auth-mobile-copyright">© 2026 NUR2 DATA</p>
      </section>
    </main>
  );
}

function WalletPanel({
  wallet,
  transactions,
  loading,
  error,
  onRetry,
  paymentStatus,
  onVerifyPayment,
  onClearPaymentStatus,
}) {
  const [amount, setAmount] = useState("1000");
  const [funding, setFunding] = useState(false);
  const [fundingError, setFundingError] = useState("");

  async function handleFunding(event) {
    event.preventDefault();
    setFunding(true);
    setFundingError("");

    try {
      const { data, error: invokeError } = await supabase.functions.invoke(
        "initialize-wallet-funding",
        { body: { amount } },
      );
      if (invokeError || !data?.authorization_url || !data?.reference) {
        throw new Error("Unable to start a Paystack test payment.");
      }

      const checkoutUrl = new URL(data.authorization_url);
      if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.paystack.com") {
        throw new Error("Paystack returned an invalid checkout address.");
      }
      onClearPaymentStatus();
      window.location.assign(checkoutUrl.toString());
    } catch (error) {
      setFundingError(error.message || "Unable to start wallet funding. Please try again.");
      setFunding(false);
    }
  }

  return (
    <div className="wallet-view">
      <section className="wallet-balance-card" aria-label="Wallet balance">
        <div className="wallet-balance-heading">
          <span className="balance-icon"><Icon name="wallet" size={20} /></span>
          <span className="balance-label">Wallet balance</span>
          <span className="wallet-balance-status">
            {loading ? "Updating" : wallet ? "Live balance" : "Unavailable"}
          </span>
        </div>
        <p className="wallet-balance-amount" aria-live="polite">
          {wallet ? formatNaira(wallet.balance) : "₦ —"}
        </p>
        <p className="wallet-balance-note">
          {wallet
            ? "Your current balance in Nigerian Naira."
            : loading
              ? "Loading your wallet balance..."
              : "Your wallet balance is not available."}
        </p>
      </section>

      {error && (
        <div className="wallet-error" role="alert">
          <p>{error}</p>
          <button className="text-button" type="button" onClick={onRetry} disabled={loading}>
            Try again
          </button>
        </div>
      )}

      <div className="wallet-sections-grid">
        <section className="content-card wallet-section">
          <span className="wallet-section-icon wallet-section-icon-blue">
            <Icon name="arrow" size={20} />
          </span>
          <span className="eyebrow">WALLET FUNDING</span>
          <h2>Add Money</h2>
          <p>
            Securely fund your wallet using Paystack Test Mode. Payments are
            verified before your balance is updated.
          </p>
          <span className="wallet-test-mode">Paystack Test Mode</span>
          <form className="wallet-funding-form" onSubmit={handleFunding}>
            <label htmlFor="wallet-funding-amount">Amount (₦)</label>
            <input
              id="wallet-funding-amount"
              type="number"
              min="100"
              max="100000"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
              disabled={funding}
            />
            <small>Minimum ₦100 · Maximum ₦100,000</small>
            <button
              className="primary-button wallet-add-button"
              type="submit"
              disabled={funding || loading || !wallet}
            >
              {funding ? "Starting secure checkout..." : "Continue to Paystack"}
            </button>
          </form>
          {fundingError && <p className="wallet-funding-error" role="alert">{fundingError}</p>}

          {paymentStatus && (
            <div className={`wallet-payment-status wallet-payment-${paymentStatus.status}`} role="status">
              <p>{paymentStatus.message}</p>
              {["pending", "error"].includes(paymentStatus.status) && paymentStatus.reference && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => onVerifyPayment(paymentStatus.reference)}
                >
                  Verify payment
                </button>
              )}
            </div>
          )}
        </section>

        <section className="content-card wallet-section">
          <div className="wallet-transaction-heading">
            <span className="wallet-section-icon wallet-section-icon-purple">
              <Icon name="receipt" size={20} />
            </span>
            <div>
              <span className="eyebrow">WALLET ACTIVITY</span>
              <h2>Transaction History</h2>
            </div>
          </div>
          {loading ? (
            <p className="wallet-data-state" role="status">Loading your wallet transactions...</p>
          ) : error ? (
            <p className="wallet-data-state">Transaction history could not be loaded.</p>
          ) : transactions.length === 0 ? (
            <div className="wallet-empty-state">
              <span className="empty-icon"><Icon name="clock" size={22} /></span>
              <strong>No wallet transactions yet</strong>
              <p>Your wallet transactions will appear here.</p>
            </div>
          ) : (
            <ul className="wallet-transaction-list" aria-label="Wallet transactions">
              {transactions.map((transaction) => (
                <li className="wallet-transaction-row" key={transaction.id}>
                  <span className="wallet-transaction-kind">
                    <strong>
                      {transaction.transaction_type.charAt(0).toUpperCase()}
                      {transaction.transaction_type.slice(1)}
                    </strong>
                    <time dateTime={transaction.created_at}>
                      {transactionDateFormatter.format(new Date(transaction.created_at))}
                    </time>
                    {transaction.payment_status !== "successful" && (
                      <span className={`wallet-transaction-status wallet-transaction-${transaction.payment_status}`}>
                        {transaction.payment_status}
                      </span>
                    )}
                  </span>
                  <span className="wallet-transaction-amount">
                    {formatNaira(transaction.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function ServicePanel({ page }) {
  const service = services.find((item) => item.id === page);
  const isHistory = page === "history";

  return (
    <section className="content-card service-panel">
      <span className={`service-icon service-icon-${service?.color || "blue"}`}>
        <Icon name={service?.icon || "clock"} size={24} />
      </span>
      <span className="eyebrow">{isHistory ? "YOUR ACTIVITY" : "COMING SOON"}</span>
      <h2>{isHistory ? "Transaction history" : `${service?.label} is on the way`}</h2>
      <p>
        {isHistory
          ? "Your transactions will appear here once VTUGate services are connected."
          : "We're preparing this service. Transactions will be enabled when the secure VTUGate integration is configured."}
      </p>
      <div className="integration-note">
        <Icon name="shield" size={18} />
        <span>No transaction has been made. Your account is safe.</span>
      </div>
    </section>
  );
}

function Dashboard({ user }) {
  const callbackParameters = new URLSearchParams(window.location.search);
  const initialReference = callbackParameters.get("reference");
  const initialTransactionReference = callbackParameters.get("trxref");
  const hasPaymentCallback = Boolean(initialReference || initialTransactionReference);
  const [page, setPage] = useState(() => hasPaymentCallback ? "wallet" : "dashboard");
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [message, setMessage] = useState("");
  const [wallet, setWallet] = useState(null);
  const [walletTransactions, setWalletTransactions] = useState([]);
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletError, setWalletError] = useState("");
  const [paymentStatus, setPaymentStatus] = useState(() => (
    initialReference
    && initialTransactionReference
    && initialReference !== initialTransactionReference
      ? {
          status: "error",
          message: "The Paystack callback references did not match. No funds were added.",
          reference: null,
        }
      : null
  ));
  const walletRequestId = useRef(0);
  const handledPaymentReference = useRef("");
  const firstName = user.email?.split("@")[0] || "there";
  const initials = (user.email?.[0] || "N").toUpperCase();

  const loadWalletData = useCallback(async () => {
    const requestId = ++walletRequestId.current;

    try {
      const [walletResponse, transactionsResponse] = await Promise.all([
        supabase
          .from("wallets")
          .select("balance")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("wallet_transactions")
          .select("id, transaction_type, amount, created_at, payment_status")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false }),
      ]);

      if (walletResponse.error) throw walletResponse.error;
      if (transactionsResponse.error) throw transactionsResponse.error;
      if (!walletResponse.data) {
        if (requestId === walletRequestId.current) {
          setWallet(null);
          setWalletTransactions([]);
          setWalletError("We couldn't find a wallet for this account. Please contact support.");
        }
        return;
      }

      if (requestId === walletRequestId.current) {
        setWallet(walletResponse.data);
        setWalletTransactions(transactionsResponse.data);
      }
    } catch (error) {
      console.error("Unable to load wallet data:", error);
      if (requestId === walletRequestId.current) {
        setWallet(null);
        setWalletTransactions([]);
        setWalletError("We couldn't load your wallet data. Check your connection and try again.");
      }
    } finally {
      if (requestId === walletRequestId.current) setWalletLoading(false);
    }
  }, [user.id]);

  const verifyPayment = useCallback(async (reference) => {
    setPaymentStatus({
      status: "verifying",
      message: "Verifying your payment directly with Paystack...",
      reference,
    });

    try {
      const { data, error } = await supabase.functions.invoke("verify-wallet-funding", {
        body: { reference },
      });

      if (error || !data || !["successful", "pending", "failed"].includes(data.status)) {
        setPaymentStatus({
          status: "error",
          message: "We couldn't verify this payment. No funds were added. Please try again.",
          reference,
        });
        return;
      }

      const messages = {
        successful: "Payment verified by Paystack. Your wallet balance has been updated.",
        pending: "Paystack has not confirmed this payment yet. Your wallet has not been credited.",
        failed: "Paystack reported that this payment failed. Your wallet has not been credited.",
      };
      setPaymentStatus({ status: data.status, message: messages[data.status], reference });
      if (data.status === "successful") {
        setWalletLoading(true);
        loadWalletData();
      }
    } catch {
      setPaymentStatus({
        status: "error",
        message: "We couldn't verify this payment. No funds were added. Please try again.",
        reference,
      });
    }
  }, [loadWalletData]);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) loadWalletData();
    });
    return () => {
      active = false;
      walletRequestId.current += 1;
    };
  }, [loadWalletData]);

  useEffect(() => {
    const callbackUrl = new URL(window.location.href);
    const reference = callbackUrl.searchParams.get("reference");
    const transactionReference = callbackUrl.searchParams.get("trxref");
    if (!reference && !transactionReference) return;

    callbackUrl.searchParams.delete("reference");
    callbackUrl.searchParams.delete("trxref");
    window.history.replaceState(
      window.history.state,
      "",
      `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`,
    );

    if (reference && transactionReference && reference !== transactionReference) {
      return;
    }

    const paymentReference = reference || transactionReference;
    if (paymentReference && handledPaymentReference.current !== paymentReference) {
      handledPaymentReference.current = paymentReference;
      verifyPayment(paymentReference);
    }
  }, [verifyPayment]);

  function refreshWalletData() {
    setWalletLoading(true);
    setWalletError("");
    loadWalletData();
  }

  function clearPaymentStatus() {
    setPaymentStatus(null);
  }

  async function handleLogout() {
    setSigningOut(true);
    setMessage("");
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (error) {
      setMessage(error.message || "Unable to sign out. Please try again.");
      setSigningOut(false);
    }
  }

  function navigateTo(target) {
    if (target === "wallet") refreshWalletData();
    setPage(target);
    setMenuOpen(false);
  }

  return (
    <div className="dashboard-shell">
      <aside className={`sidebar${menuOpen ? " sidebar-open" : ""}`}>
        <Brand />
        <p className="nav-caption">MENU</p>
        <nav className="side-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              className={`nav-link${page === item.id ? " nav-link-active" : ""}`}
              key={item.id}
              onClick={() => navigateTo(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
              {item.id === "dashboard" && <span className="nav-indicator" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-help">
            <span className="help-icon"><Icon name="spark" size={19} /></span>
            <strong>Here for you</strong>
            <p>Need help? Our support team is ready.</p>
            <a href="mailto:support@nur2data.com">Contact support <Icon name="arrow" size={14} /></a>
          </div>
          <button className="logout-button" onClick={handleLogout} disabled={signingOut}>
            <Icon name="logout" size={18} />
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </aside>

      {menuOpen && (
        <button
          className="mobile-backdrop"
          aria-label="Close navigation menu"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <main className="dashboard-main">
        <header className="topbar">
          <button
            className="mobile-menu-button"
            aria-label="Open navigation menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Icon name="menu" size={22} />
          </button>
          <div className="mobile-topbar-brand"><Brand compact /></div>
          <div className="breadcrumb">
            <span>Workspace</span><span className="breadcrumb-slash">/</span>
            <strong>{navigation.find((item) => item.id === page)?.label || "Dashboard"}</strong>
          </div>
          <div className="topbar-account">
            <div className="account-copy">
              <strong>{user.email}</strong>
              <span>Personal account</span>
            </div>
            <span className="avatar" aria-label={`Signed in as ${user.email}`}>{initials}</span>
            <button className="topbar-logout" onClick={handleLogout} disabled={signingOut}>
              <Icon name="logout" size={17} />
              <span>{signingOut ? "Signing out..." : "Sign out"}</span>
            </button>
          </div>
        </header>

        <div className="dashboard-content">
          {message && <p className="dashboard-message" role="alert">{message}</p>}
          {page === "dashboard" ? (
            <>
              <section className="welcome-row">
                <div>
                  <span className="eyebrow">YOUR NUR2 DATA SPACE</span>
                  <h1>Welcome, {firstName} <span aria-hidden="true">✦</span></h1>
                  <p>Your everyday services, all in one place.</p>
                </div>
                <div className="today-date">
                  <span className="date-dot" />
                  Your account is active
                </div>
              </section>

              <section className="overview-grid" aria-label="Account overview">
                <div className="balance-card">
                  <div className="balance-card-top">
                    <span className="balance-icon"><Icon name="wallet" size={20} /></span>
                    <span className="balance-label">Wallet balance</span>
                  </div>
                  <p className="balance-amount" aria-live="polite">
                    {wallet ? formatNaira(wallet.balance) : "₦ —"}
                  </p>
                  <span className="balance-note">
                    {wallet ? "Current wallet balance" : "Wallet balance unavailable"}
                  </span>
                  <button
                    className="balance-link"
                    type="button"
                    onClick={() => navigateTo("wallet")}
                  >
                    Open wallet <Icon name="arrow" size={15} />
                  </button>
                  <div className="balance-decoration" aria-hidden="true" />
                </div>
                <div className="overview-card">
                  <span className="overview-card-icon overview-icon-green"><Icon name="shield" size={20} /></span>
                  <span className="overview-label">Account status</span>
                  <strong className="overview-value">Active</strong>
                  <span className="overview-footnote">Your account is ready</span>
                </div>
                <div className="overview-card">
                  <span className="overview-card-icon overview-icon-purple"><Icon name="clock" size={20} /></span>
                  <span className="overview-label">Recent activity</span>
                  <strong className="overview-value">No transactions</strong>
                  <span className="overview-footnote">Activity will show here</span>
                </div>
              </section>

              <section className="section-block">
                <div className="section-heading">
                  <div><h2>Quick services</h2><p>Choose what you need to do</p></div>
                </div>
                <div className="service-grid">
                  {services.map((service) => (
                    <button
                      className="service-card"
                      key={service.id}
                      onClick={() => navigateTo(service.id)}
                    >
                      <span className={`service-icon service-icon-${service.color}`}>
                        <Icon name={service.icon} size={22} />
                      </span>
                      <span className="service-card-copy">
                        <strong>{service.label}</strong>
                        <small>{service.description}</small>
                      </span>
                      <span className="service-arrow"><Icon name="arrow" size={17} /></span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="section-block activity-block">
                <div className="section-heading">
                  <div><h2>Recent activity</h2><p>Your latest account transactions</p></div>
                  <button className="text-button" onClick={() => navigateTo("history")}>
                    View history <Icon name="arrow" size={16} />
                  </button>
                </div>
                <div className="empty-activity">
                  <span className="empty-icon"><Icon name="receipt" size={22} /></span>
                  <strong>No activity yet</strong>
                  <p>Your completed transactions will appear here.</p>
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="welcome-row page-welcome">
                <div>
                  <span className="eyebrow">YOUR NUR2 DATA SPACE</span>
                  <h1>{navigation.find((item) => item.id === page)?.label}</h1>
                  <p>Manage your everyday services from one simple place.</p>
                </div>
              </section>
              {page === "data" ? (
                <DataPlansPanel />
              ) : page === "wallet" ? (
                <WalletPanel
                  wallet={wallet}
                  transactions={walletTransactions}
                  loading={walletLoading}
                  error={walletError}
                  onRetry={refreshWalletData}
                  paymentStatus={paymentStatus}
                  onVerifyPayment={verifyPayment}
                  onClearPaymentStatus={clearPaymentStatus}
                />
              ) : (
                <ServicePanel page={page} />
              )}
            </>
          )}
          <footer className="dashboard-footer">
            <span>© 2026 NUR2 DATA</span>
            <span><Icon name="shield" size={14} /> Secure account access</span>
          </footer>
        </div>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {mobileNavigation.map((item) => (
          <button
            key={item.id}
            className={page === item.id ? "mobile-nav-active" : ""}
            onClick={() => navigateTo(item.id)}
            aria-current={page === item.id ? "page" : undefined}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function AuthenticatedApp() {
  const [user, setUser] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  useEffect(() => {
    let active = true;
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) {
        setUser(session?.user ?? null);
        setSessionChecked(true);
      }
    });

    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) throw error;
        setUser(data.session?.user ?? null);
        setSessionChecked(true);
      })
      .catch((error) => {
        if (!active) return;
        console.error("Unable to restore the Supabase session:", error);
        setSessionChecked(true);
      });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  if (!sessionChecked) {
    return <main className="session-loading" aria-label="Loading your account"><span /></main>;
  }

  return user ? <Dashboard user={user} /> : <AuthScreen />;
}

function SupabaseConfigurationError() {
  return (
    <main className="config-screen">
      <section className="config-card">
        <Brand compact />
        <span className="eyebrow">SETUP REQUIRED</span>
        <h1>Connect your Supabase project</h1>
        <p role="alert">{supabaseConfigError}</p>
        <p>
          Set <code>VITE_SUPABASE_URL</code> to the Project URL shown in your
          Supabase project settings. Keep the publishable key in{" "}
          <code>VITE_SUPABASE_ANON_KEY</code>, then restart the Vite server.
        </p>
      </section>
    </main>
  );
}

function App() {
  if (supabaseConfigError) {
    return <SupabaseConfigurationError />;
  }

  return <AuthenticatedApp />;
}

export default App;
