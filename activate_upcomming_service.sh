#!/bin/bash

API_URL="https://studio.maitretech.com/rest/v1/projects?select=*,service!inner(*,installments(*))&service.installments.is_paid=eq.true"
API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE"

TODAY=$(date -u +%Y-%m-%d)
NEXT_7_DAYS=$(date -u -d "+7 days" +%Y-%m-%d)



response=$(curl -s "$API_URL" \
  -H "apikey: $API_KEY" \
  -H "Authorization: Bearer $API_KEY")



echo "$response" | jq -c '.[]' | while read -r project; do
    project_id=$(echo "$project" | jq -r '.id')
    prj_name=$(echo "$project" | jq -r '.prj_name')
    customer_id=$(echo "$project" | jq -r '.customer_id')  # adjust if different field

    active_service=$(echo "$project" | jq -c '.service[] | select(.is_active == true)')
    upcoming_service=$(echo "$project" | jq -c '.service[] | select(.is_active == false and .status == "new")')

    if [ -z "$active_service" ]; then
        echo "No active service for $prj_name"
        continue
    fi

    end_date=$(echo "$active_service" | jq -r '.end_date')
    service_amount=$(echo "$active_service" | jq -r '.amount | tonumber')
    service_discount=$(echo "$active_service" | jq -r '.discount // 0')
    service_amount_with_discount=$(echo "$service_amount - $service_discount" | bc)
    total_paid=$(echo "$active_service" | jq '[.installments[] | select(.is_paid == true) | .amount] | add // 0')
    active_service_id=$(echo "$active_service" | jq -r '.id')

    payment_status="FULLY PAID"
    if [ "$total_paid" -lt "$service_amount_with_discount" ]; then
        payment_status="NOT FULLY PAID"
    fi

    echo "-----------------------------------"
    echo "Project: $prj_name"
    echo "Service End Date: $end_date"
    echo "Payment Status: $payment_status"
    echo "-----------------------------------"

    if [[ "$end_date" < "$TODAY" ]]; then
        echo "Status: EXPIRED SERVICE"

        if [ -n "$upcoming_service" ]; then
            up_amount=$(echo "$upcoming_service" | jq -r '.amount | tonumber')
            up_discount=$(echo "$upcoming_service" | jq -r '.discount // 0')
            up_total=$(echo "$upcoming_service" | jq '[.installments[] | select(.is_paid == true) | .amount] | add // 0')
            up_amount_with_discount=$(echo "$up_amount - $up_discount" | bc)
            upcoming_service_id=$(echo "$upcoming_service" | jq -r '.id')

            if [ "$up_total" -ge "$up_amount_with_discount" ]; then
                echo "Upcoming service is fully paid. Updating statuses..."

                # PATCH active service -> inactive
                curl -s -X PATCH "https://studio.maitretech.com/rest/v1/service?id=eq.$active_service_id" \
                     -H "apikey: $API_KEY" \
                     -H "Authorization: Bearer $API_KEY" \
                     -H "Content-Type: application/json" \
                     -d '{
                        "is_active": false,
                        "status": "inactive"
                        }'

                # PATCH upcoming service -> active
                curl -s -X PATCH "https://studio.maitretech.com/rest/v1/service?id=eq.$upcoming_service_id" \
                     -H "apikey: $API_KEY" \
                     -H "Authorization: Bearer $API_KEY" \
                     -H "Content-Type: application/json" \
                     -d '{
                        "is_active": true,
                        "status": "active"
                        }'

                echo "Active service marked inactive, upcoming service marked active."

            else
                echo "Upcoming service exists but is NOT fully paid. Cannot activate."
            fi
        else
            echo "No upcoming service available to activate."
        fi

    else
        echo "Status: ACTIVE SERVICE (not expiring soon)"
    fi

done

echo "Done."