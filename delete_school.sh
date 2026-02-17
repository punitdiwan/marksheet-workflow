#!/bin/bash

# API endpoint
URL="https://franchise.edusparsh.com/api/school"

SUPABASE_API_URL="https://studio.maitretech.com/rest/v1/projects"
SUPABASE_API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE"



echo "Fetching school_ids (prj_name)..."

# ==========================
# Fetch prj_name & Loop
# ==========================

TODAY=$(date -u +"%Y-%m-%d")
TODAY_SECONDS=$(date -u -d "$TODAY" +%s)

echo "📅 Today (UTC): $TODAY"
echo ""

curl -s "${SUPABASE_API_URL}?apikey=${SUPABASE_API_KEY}&is_trial=eq.true" \
| jq -c '.[]' \
| while read -r SCHOOL_DATA; do

    SCHOOL_ID=$(echo "$SCHOOL_DATA" | jq -r '.prj_name')
    TRIAL_END=$(echo "$SCHOOL_DATA" | jq -r '.trial_ends_at' | cut -d'T' -f1)

    if [[ -z "$SCHOOL_ID" ]]; then
        continue
    fi

    TRIAL_END_SECONDS=$(date -u -d "$TRIAL_END" +%s)
    DIFF_DAYS=$(( (TRIAL_END_SECONDS - TODAY_SECONDS) / 86400 ))

    echo "➡️  Processing: $SCHOOL_ID"
    echo "   Trial Ends At: $TRIAL_END"

    if [[ "$DIFF_DAYS" -lt 0 ]]; then
        echo "   ❌ Trial EXPIRED ($((-DIFF_DAYS)) days ago)"
        echo "   🔥 Calling DELETE API..."

        curl -s -X DELETE "$URL" \
          -H "Content-Type: application/x-www-form-urlencoded" \
          -d "project_name=$SCHOOL_ID" \
          -d "action=delete"

        echo "   🗑 Deleted: $SCHOOL_ID"
        echo "   ⏳ Waiting 60 seconds before next action..."
        sleep 60
    else
        echo "   ✅ Trial still ACTIVE ($DIFF_DAYS day(s) remaining)"
    fi

    echo ""
done

echo "🎉 Expired trial cleanup completed."

echo "🎉 Done checking trials."










