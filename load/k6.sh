#!/usr/bin/env sh
set -eu

if command -v k6 >/dev/null 2>&1; then
    exec k6 "$@"
fi

forward=""
for name in BASE_URL PROFILE RATE DURATION LOAD_USERS RATE_PUBLICREAD RATE_AVAILABILITY RATE_BOOKINGS RATE_AUTH; do
    eval "value=\${$name:-}"
    [ -n "$value" ] && forward="$forward -e $name=$value"
done

exec docker run --rm -i \
    --add-host=host.docker.internal:host-gateway \
    -v "$PWD:/work" -w /work \
    -e BASE_URL="${BASE_URL:-http://host.docker.internal:8080/api/v1}" \
    $forward \
    grafana/k6 "$@"
