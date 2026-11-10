const INDIAN_MOBILE_ERROR = "Enter a valid 10-digit Indian mobile number, optionally prefixed with 91 or +91.";

export function normalizeIndianMobile(value: string): string | null {
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;
  const mobile = digits.length === 10
    ? digits
    : digits.length === 12 && digits.startsWith("91")
      ? digits.slice(2)
      : "";
  return /^[6-9]\d{9}$/.test(mobile) ? `+91${mobile}` : null;
}

export { INDIAN_MOBILE_ERROR };
