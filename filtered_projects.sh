#!/bin/bash

INPUT_FILE="project.txt"
OUTPUT_FILE="filtered_projects.txt"

> "$OUTPUT_FILE"   # clear output file

while read -r schema; do
    echo "Checking schema: $schema"

    result=$(psql -h "studio.maitretech.com" \
                  -U "postgres" \
                  -d "postgres" \
                  -t -A \
                  -c "SELECT config_value 
                      FROM ${schema}.configurations 
                      WHERE config_key = 'birthday_reminder'
                      LIMIT 1;")

    # Trim spaces
    result=$(echo "$result" | xargs)

    if [[ "$result" == "true" ]]; then
        echo "$schema" >> "$OUTPUT_FILE"
    else
        echo "❌ Removing $schema (birthday_reminder != true)"
    fi

done < "$INPUT_FILE"

echo "✅ Filtered list saved in $OUTPUT_FILE"

