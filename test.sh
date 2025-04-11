# config_file="postgrest.conf"

# # Extract the schema names from the config file
# db-schemas=$(grep -oP 'db-schemas\s*=\s*"\K[^"]+' "$config_file")
# del_schema="rehan"

# # Convert the extracted comma-separated list into a JSON array
# array=$(echo "$de_schema" | sed 's/,/","/g' | sed 's/^/["/' | sed 's/$/"]/')

# # Remove the del_schema ("zeeshan") from the array using jq
# filtered_array=$(echo "$array" | jq --arg db-schemas "$del_schema" '[.[] | select(. != $del_schema)]')

# # Print the filtered array
# echo "Filtered array: $filtered_array"

# append=""

# for item in $(echo "$filtered_array" | jq -r '.[]'); do
#     echo "$item"
#     append="${append},${item}"
# done
# echo "$append"

# str=$append

# # Remove the leading comma, if it exists
# cleaned_str=$(echo "$str" | sed 's/^,//')

# echo "db-schemas = \"$cleaned_str\"" > "$config_file"


#!/bin/bash

echo "Try programiz.pro"
config_file="postgrest.conf"
# Original comma-separated string
arr=$(grep -oP 'db-schemas\s*=\s*"\K[^"]+' "$config_file")
# arr="zeeshan,reshan,madhu"

# Value to filter out
filter="zeeshan"

# Convert the string into an array
IFS=',' read -ra arr_items <<< "$arr"
echo "$arr_items"

# Filter the array
result=""
for item in "${arr_items[@]}"; do
    item=$(echo "$item" | xargs)
  if [[ "$item" != "$filter" ]]; then
    if [[ -n "$result" ]]; then
      result+=","
    fi
    result+="$item"
  fi
done

echo "$result"  # Output: zeeshan,reshan
echo "db-schemas = \"$result\"" > "$config_file"

