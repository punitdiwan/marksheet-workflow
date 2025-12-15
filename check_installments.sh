#!/bin/bash

# ==========================
# Configuration
# ==========================
SUPABASE_API_URL="https://studio.maitretech.com/rest/v1/projects"
SUPABASE_API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE"

NEXT_API_URL="https://jnpsbhopal.edusparsh.com/api/unpaidInstallments"

OUTPUT_DIR="$(pwd)/results"

# ==========================
# Setup
# ==========================
mkdir -p "$OUTPUT_DIR"

echo "Fetching school_ids (prj_name)..."

# ==========================
# Fetch prj_name & Loop
# ==========================
curl -s \
  "${SUPABASE_API_URL}?apikey=${SUPABASE_API_KEY}&is_trial=eq.false&is_disabled=eq.false" \
| jq -r '.[].prj_name' \
| sort -u \
| while read -r SCHOOL_ID; do

    # Skip empty values
    if [[ -z "$SCHOOL_ID" ]]; then
      continue
    fi

    echo "➡️  Processing school_id: $SCHOOL_ID"

    RESPONSE=$(curl -s \
      -H "school-id: $SCHOOL_ID" \
      -H "Content-Type: application/json" \
      "$NEXT_API_URL")

    # Make filename safe (remove spaces & special chars)
    SAFE_NAME=$(echo "$SCHOOL_ID" | tr ' /' '__')

    # Save response per school
    echo "$RESPONSE" > "${OUTPUT_DIR}/${SAFE_NAME}.json"

    echo "✅ Saved ${OUTPUT_DIR}/${SAFE_NAME}.json"
done

echo "🎉 All schools processed."


OUTPUT_DIR="$(pwd)/results"
TODAY_EPOCH=$(date -u -d "$(date -u +%Y-%m-%d) 00:00:00" +"%s")

# Array to hold schools to disable
SCHOOLS_TO_DISABLE=()

echo "Checking installments expiry..."

for FILE in "$OUTPUT_DIR"/*.json; do
  SCHOOL_NAME=$(basename "$FILE" .json)
  EXPIRED=$(jq -r --arg today "$TODAY_EPOCH" '
    (.installments // [])[]
    | select(.end_date != null)
    | (.end_date | sub("\\+00:00$"; "Z") | fromdateiso8601) as $end_epoch
    | (($end_epoch - ($today | tonumber))/86400 | floor) as $days_remaining
    | select($days_remaining < 0)   # <-- strictly less than 0
    | .name
  ' "$FILE")
  if [[ -n "$EXPIRED" ]]; then
    echo "❌ Installments expired for school: $SCHOOL_NAME -> $EXPIRED"
    SCHOOLS_TO_DISABLE+=("$SCHOOL_NAME")
  fi
done

echo "${SCHOOLS_TO_DISABLE[@]}"


# Call API if there are schools to disable
if [ ${#SCHOOLS_TO_DISABLE[@]} -gt 0 ]; then
  echo "Calling disable-schools API for ${#SCHOOLS_TO_DISABLE[@]} schools..."
  
  # Convert Bash array to JSON array
  SCHOOLS_JSON=$(printf '%s\n' "${SCHOOLS_TO_DISABLE[@]}" | jq -R . | jq -s .)

  curl -X POST "https://jnpsbhopal.edusparsh.com/api/disableSchool" \
       -H "Content-Type: application/json" \
       -d "{\"schoolNames\": $SCHOOLS_JSON}"
else
  echo "No schools have expired installments. Nothing to disable."
fi

echo "✅ Check completed."

