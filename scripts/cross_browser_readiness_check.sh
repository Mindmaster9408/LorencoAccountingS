#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

apps=(
  "accounting-ecosystem/frontend-ecosystem"
  "accounting-ecosystem/frontend-accounting"
  "Point of Sale"
  "Payroll/Payroll_App"
)

count_optional() {
  (grep -Rno --include='*.html' --include='*.js' '\?\.' "$1" 2>/dev/null || true) | wc -l | tr -d ' '
}

count_locale_dates() {
  (grep -Rno --include='*.html' --include='*.js' -E 'toLocaleDateString\(|toLocaleString\(|toLocaleTimeString\(' "$1" 2>/dev/null || true) | wc -l | tr -d ' '
}

count_storage() {
  (grep -Rno --include='*.html' --include='*.js' -E 'localStorage\.|sessionStorage\.' "$1" 2>/dev/null || true) | wc -l | tr -d ' '
}

echo "Cross-Browser Readiness Snapshot"
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo
printf '%-45s | %10s | %12s | %11s\n' "APP" "OPTIONAL?." "LOCALE-DATE" "STORAGE API"
printf '%-45s-+-%10s-+-%12s-+-%11s\n' "---------------------------------------------" "----------" "------------" "-----------"

sum_opt=0
sum_date=0
sum_store=0

for app in "${apps[@]}"; do
  opt=$(count_optional "$app")
  dat=$(count_locale_dates "$app")
  stg=$(count_storage "$app")

  sum_opt=$((sum_opt + opt))
  sum_date=$((sum_date + dat))
  sum_store=$((sum_store + stg))

  printf '%-45s | %10d | %12d | %11d\n' "$app" "$opt" "$dat" "$stg"
done

echo
printf '%-45s | %10d | %12d | %11d\n' "TOTAL" "$sum_opt" "$sum_date" "$sum_store"

echo
if [[ "$sum_opt" -eq 0 ]]; then
  echo "Optional chaining in browser-delivered JS/HTML: PASS"
else
  echo "Optional chaining in browser-delivered JS/HTML: ACTION NEEDED"
fi

if [[ "$sum_date" -eq 0 ]]; then
  echo "Locale-dependent date formatting: PASS"
else
  echo "Locale-dependent date formatting: ACTION NEEDED"
fi

echo "Storage API usage: REVIEW REQUIRED (ensure safe wrappers and fallback behavior)"
