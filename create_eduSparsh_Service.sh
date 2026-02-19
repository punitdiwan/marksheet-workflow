#!/bin/bash

API_URL="https://studio.maitretech.com/rest/v1/projects?select=*,service!inner(*,installments(*))&service.installments.is_paid=eq.true"
API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE"

TODAY=$(date -u +%Y-%m-%d)
NEXT_7_DAYS=$(date -u -d "+7 days" +%Y-%m-%d)

echo "Checking services expiring between $TODAY and $NEXT_7_DAYS"

response=$(curl -s "$API_URL" \
  -H "apikey: $API_KEY" \
  -H "Authorization: Bearer $API_KEY")

echo "$response" | jq -c '.[]' | while read -r project; do

    project_id=$(echo "$project" | jq -r '.id')
    prj_name=$(echo "$project" | jq -r '.prj_name')

    # ✅ Get ONLY active service
    active_service=$(echo "$project" | jq -c '.service[] | select(.is_active == true)')
    upcomming_service=$(echo "$project" | jq -c '.service[] | select(.is_active == false and .status == "new")')

    if [ -z "$active_service" ]; then
        echo "No active service for $prj_name"
        continue
    fi

    end_date=$(echo "$active_service" | jq -r '.end_date')
    # Extract service amount as integer
    service_amount=$(echo "$active_service" | jq -r '.amount | tonumber')

    service_discount=$(echo "$active_service" | jq -r '.discount // 0')
    service_amount_with_discount=$(echo "$service_amount - $service_discount" | bc)

    # ✅ Calculate total paid installments
    total_paid=$(echo "$active_service" | jq '[.installments[] | select(.is_paid == true) | .amount] | add // 0')

    # ✅ Compare paid amount with service amount
    if [ "$total_paid" -lt "$service_amount_with_discount" ]; then
        payment_status="NOT FULLY PAID"
    else
        payment_status="FULLY PAID"
    fi

    echo "-----------------------------------"
    echo "Project: $prj_name"
    echo "Service End Date: $end_date"
    echo "Service Amount: $service_amount"
    echo "Total Paid: $total_paid"
    echo "Payment Status: $payment_status"
    echo "Service Amount (with discount): $service_amount_with_discount"
    echo "Active Service Status: $(echo "$active_service" | jq -r '.status')"
    echo "-----------------------------------"

    # ✅ Categorize based on end_date
    if [[ "$end_date" < "$TODAY" ]]; then
        echo "Status: EXPIRED SERVICE"

    elif [[ "$end_date" > "$TODAY" && "$end_date" < "$NEXT_7_DAYS" ]]; then
        echo "Status: UPCOMING EXPIRY (within 7 days)"

        # ✅ Only create if FULLY PAID
        if [ "$total_paid" -lt "$service_amount_with_discount" ]; then
            echo "Service NOT fully paid for $prj_name. Skipping creation."
            continue
        else
            echo "Service fully paid for $prj_name"
        fi

        # ✅ Check if upcoming service already exists
        if [ -n "$upcomming_service" ]; then
            echo "Upcoming service already exists. Skipping creation."
        else
            echo "Creating new upcoming service..."

            new_start_date=$(date -u -d "$end_date +1 day" +%Y-%m-%d)
            new_end_date=$(date -u -d "$new_start_date +1 year -1 day" +%Y-%m-%d)

            start_year=$(date -d "$new_start_date" +%Y)
            end_year=$(date -d "$new_end_date" +%Y)

            service_name="EduSparsh-AY-${start_year}-${end_year}"
            echo "Generated Service Name: $service_name"

            # Fetch customer
            customer=$(curl -s \
                "https://studio.maitretech.com/rest/v1/customers?school_id=eq.$prj_name" \
                -H "apikey: $API_KEY" \
                -H "Authorization: Bearer $API_KEY")

            customer_id=$(echo "$customer" | jq -r '.[0].id')

            if [ -z "$customer_id" ] || [ "$customer_id" == "null" ]; then
                echo "Customer not found. Skipping."
                continue
            fi
            # Generate a unique ID for the new service
            new_service_id=$(uuidgen)  # requires 'uuidgen' installed on Linux/macOS

            # Create service 
            # Create service and capture response
            create_response=$(curl -s -w "\n%{http_code}" -X POST "https://studio.maitretech.com/rest/v1/service" \
                -H "apikey: $API_KEY" \
                -H "Authorization: Bearer $API_KEY" \
                -H "Content-Type: application/json" \
                -H "Prefer: return=representation" \
                -d "{   
                        \"id\": \"$new_service_id\",
                        \"project_id\": $project_id,
                        \"customer\": \"$customer_id\",
                        \"school_id\": \"$prj_name\",
                        \"start_date\": \"$new_start_date\",
                        \"billing_date\": \"$new_start_date\",
                        \"end_date\": \"$new_end_date\",
                        \"amount\": $service_amount,
                        \"service_name\": \"$service_name\",
                        \"status\": \"new\",
                        \"is_active\": false
                    }")

            # Split response and HTTP status
            http_body=$(echo "$create_response" | head -n -1)
            http_status=$(echo "$create_response" | tail -n1)

                    # Print for debugging
            echo "HTTP Status: $http_status"
            echo "Response Body: $http_body"

            if [ "$http_status" -ge 200 ] && [ "$http_status" -lt 300 ]; then
            new_service_id=$(echo "$http_body" | jq -r '.[0].id // empty')
            if [ -z "$new_service_id" ]; then
                echo "Service created but ID missing! Skipping service_products insert."
                continue
            fi

            # Insert service_products
            curl -s -X POST "https://studio.maitretech.com/rest/v1/service_products" \
                -H "apikey: $API_KEY" \
                -H "Authorization: Bearer $API_KEY" \
                -H "Content-Type: application/json" \
                -d "{
                        \"service_id\": \"$new_service_id\",
                        \"product_id\": 4,
                        \"customer_id\": \"$customer_id\"
                    }"
            echo "Inserted into service_products."
        else
            echo "Service creation failed! Response: $http_body"
            continue
        fi

            echo "New upcoming service created successfully."
        fi

    else
        echo "Status: ACTIVE SERVICE (not expiring soon)"
    fi

done

echo "Done."