#!/usr/bin/env bash
#UNSPLASH_ACCESS_KEY="Id1mADaAdCD5c-9WxP1yfunWNsM3THyPUSG6WbmgTaI"
#PEXELS_API_KEY="8ozWcE2zyaFI5rnHLlTi722oOy7WQsikYO5xNjSD2hf7IZJId7quWYEJ"
#PIXABAY_API_KEY="55776976-6107877f06a6a951fcd060b77"


set -Eeuo pipefail
IFS=$'\n\t'

############################################
# API KEYS (ADD YOUR OWN)
############################################
UNSPLASH_ACCESS_KEY="Id1mADaAdCD5c-9WxP1yfunWNsM3THyPUSG6WbmgTaI"
PEXELS_API_KEY="8ozWcE2zyaFI5rnHLlTi722oOy7WQsikYO5xNjSD2hf7IZJId7quWYEJ"
PIXABAY_API_KEY="55776976-6107877f06a6a951fcd060b77"

############################################
# CONFIG
############################################
INPUT_JSON="./testProducts.json"
BACKUP_JSON="./testProducts.backup.json"
IMAGES_DIR="./images"
LOG_FILE="./image_download.log"

# Which translation to use as the search source.
# 1 = Serbian, 2 = ?, 3 = English, 4 = Russian (per provided sample)
SEARCH_LANGUAGE_ID=3

# Global max images per script execution
MAX_IMAGES_PER_RUN=100

# Per product
MIN_IMAGES_PER_PRODUCT=1
MAX_IMAGES_PER_PRODUCT=4

# Leave empty for random mode
FORCE_IMAGES_PER_PRODUCT=""

# Runtime
MAX_RETRIES_PER_IMAGE=3
REQUEST_TIMEOUT=30
SLEEP_BETWEEN_REQUESTS=2

############################################
# DEPENDENCIES
############################################
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1"
    exit 1
  }
}

require_cmd jq
require_cmd curl
require_cmd sed
require_cmd awk
require_cmd grep
require_cmd mktemp
require_cmd file
require_cmd shasum
require_cmd iconv

############################################
# INIT
############################################
mkdir -p "$IMAGES_DIR"
touch "$LOG_FILE"

if [[ ! -f "$INPUT_JSON" ]]; then
  echo "Missing $INPUT_JSON"
  exit 1
fi

if [[ ! -f "$BACKUP_JSON" ]]; then
  cp "$INPUT_JSON" "$BACKUP_JSON"
fi

UNSPLASH_ACTIVE=1
PEXELS_ACTIVE=1
PIXABAY_ACTIVE=1

TOTAL_DOWNLOADED_THIS_RUN=0

############################################
# LOGGING
############################################
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

############################################
# SAFE JSON WRITE
# Writes to a temp file, validates it, then atomically replaces target.
# Prevents corruption if jq produces bad output mid-run.
############################################
safe_json_write() {
  local target="$1"
  local tmp_file="$2"

  if ! jq empty "$tmp_file" >/dev/null 2>&1; then
    rm -f "$tmp_file"
    log "ERROR: refusing to write invalid JSON to $target"
    return 1
  fi

  mv "$tmp_file" "$target"
}

############################################
# HELPERS
############################################
sanitize_filename() {
  echo "$1" | \
    iconv -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null | \
    tr '[:upper:]' '[:lower:]' | \
    sed 's/[^a-z0-9]/ /g' | \
    awk '{for(i=1;i<=NF;i++) if(length($i)>1) printf $i "-"}' | \
    sed 's/-$//'
}

random_image_count() {
  local range=$((MAX_IMAGES_PER_PRODUCT - MIN_IMAGES_PER_PRODUCT + 1))
  echo $(( (RANDOM % range) + MIN_IMAGES_PER_PRODUCT ))
}

determine_target_count() {
  local remaining_slots="$1"

  local requested
  if [[ -n "$FORCE_IMAGES_PER_PRODUCT" ]]; then
    requested="$FORCE_IMAGES_PER_PRODUCT"
  else
    requested=$(random_image_count)
  fi

  if (( requested > remaining_slots )); then
    echo "$remaining_slots"
  else
    echo "$requested"
  fi
}

is_valid_image() {
  local filepath="$1"
  [[ -s "$filepath" ]] || return 1
  file "$filepath" | grep -E 'image|JPEG|PNG|WebP' >/dev/null 2>&1
}

is_duplicate_image() {
  local filepath="$1"
  local new_hash
  new_hash=$(shasum "$filepath" | awk '{print $1}')

  while IFS= read -r existing; do
    [[ "$existing" == "$filepath" ]] && continue
    local existing_hash
    existing_hash=$(shasum "$existing" | awk '{print $1}')
    if [[ "$new_hash" == "$existing_hash" ]]; then
      return 0
    fi
  done < <(find "$IMAGES_DIR" -type f)

  return 1
}

############################################
# SEARCH QUALITY ENGINE
#
# Strategy: tokenize the English product name, drop low-signal stopwords
# (verbs, condition adjectives, articles, etc.), keep the high-signal
# tokens (brands, model numbers, product type, materials), then append
# a category-aware context phrase + product photography keywords.
############################################

# Words that hurt image search relevance for product listings.
# Brands and models stay; condition/sales/listing fluff goes.
SEARCH_STOPWORDS_REGEX='^(the|a|an|and|or|but|of|for|to|in|on|at|by|with|from|as|is|are|was|were|be|been|being|am|i|me|my|we|our|you|your|it|its|this|that|these|those|here|there|new|old|used|like|brand|original|originalna|originalan|genuine|authentic|condition|excellent|perfect|great|good|nice|mint|fine|fair|sale|selling|sell|sold|buy|bought|prodajem|prodaja|product|item|piece|pieces|set|pair|pack|lot|bundle|kit|edition|version|model|type|size|small|medium|large|xl|xxl|free|cheap|affordable|quality|premium|high|low|professional|pro|original|reason|listing|description|shipping|delivery|courier|pickup|cash|payment|buyer|seller|please|hello|hi|all|any|some|each|every|more|less|much|very|really|just|only|also|too|not|no|yes|can|could|will|would|should|may|might|must|have|has|had|do|does|did|get|got|made|make|use|using|fits|fit|works|work|comes|come|years|year|months|month|days|day|hours|hour)$'

# Map (top|sub|final) category fragments to a context phrase that improves
# image search relevance. Ordered most-specific-first so final category wins.
category_context_for() {
  local final="$1"
  local sub="$2"
  local top="$3"

  case "$final" in
    *phone_cases_covers*)   echo "smartphone case cover product photography" ;;
    *phone_chargers*)       echo "phone charger cable adapter product photo" ;;
    *phone_screens*)        echo "smartphone replacement screen display" ;;
    *phones_accessories*)   echo "phone accessory product photo isolated" ;;
    *phones*)               echo "smartphone mobile phone product photo" ;;
    *headphones*)           echo "headphones audio product photo isolated" ;;
    *earphones*|*earbuds*)  echo "earbuds wireless audio product photo" ;;
    *speakers*)             echo "speaker audio device product photo" ;;
    *televisions*|*tv*)     echo "television flat screen product photo" ;;
    *laptops*)              echo "laptop notebook computer product photo" ;;
    *desktops*)             echo "desktop pc computer product photo" ;;
    *monitors*)             echo "computer monitor display product photo" ;;
    *keyboards*)            echo "computer keyboard product photo" ;;
    *mice*|*mouse*)         echo "computer mouse product photo" ;;
    *cameras*)              echo "digital camera photography equipment" ;;
    *lenses*)               echo "camera lens photography equipment" ;;
    *drones*)               echo "drone quadcopter aerial product photo" ;;
    *gaming_consoles*)      echo "gaming console controller product photo" ;;
    *watches*|*smartwatches*) echo "wristwatch product photo isolated" ;;

    *shelving_bookcases*)   echo "wooden bookshelf shelving furniture" ;;
    *showcase*)             echo "display cabinet showcase furniture" ;;
    *sofas*|*couches*)      echo "sofa couch living room furniture" ;;
    *chairs*)               echo "chair seating furniture interior" ;;
    *tables*)               echo "table wooden furniture interior" ;;
    *beds*)                 echo "bed bedroom furniture interior" ;;
    *wardrobes*|*closets*)  echo "wardrobe closet bedroom furniture" ;;
    *desks*)                echo "desk office furniture interior" ;;
    *furniture*)            echo "furniture interior product photo" ;;

    *saws*)                 echo "power saw jigsaw tool workshop" ;;
    *drills*)               echo "power drill tool workshop" ;;
    *rotary_tools*)         echo "rotary multi tool workshop" ;;
    *grinders*)             echo "angle grinder power tool workshop" ;;
    *hand_tools*)           echo "hand tool workshop equipment" ;;
    *power_tools*)          echo "power tool workshop equipment" ;;

    *boots*)                echo "leather boots footwear fashion" ;;
    *sneakers*)             echo "sneakers shoes footwear product photo" ;;
    *shoes*)                echo "shoes footwear product photo" ;;
    *jackets*|*coats*)      echo "jacket coat clothing fashion" ;;
    *shirts*|*tshirts*)     echo "shirt t-shirt clothing fashion" ;;
    *trousers*|*pants*)     echo "trousers pants clothing fashion" ;;
    *dresses*)              echo "dress womens clothing fashion" ;;
    *bags*|*handbags*)      echo "handbag bag fashion accessory" ;;
    *jewelry*)              echo "jewelry product photo isolated" ;;

    *cars*|*vehicles*)      echo "car vehicle exterior photography" ;;
    *motorcycles*)          echo "motorcycle bike vehicle photography" ;;
    *bicycles*)             echo "bicycle bike cycling product photo" ;;

    *)
      # Fall back to sub then top category, cleaned up
      local fallback
      fallback=$(echo "$sub $top" | tr '._-' ' ' | sed 's/category//g')
      echo "$fallback product photo"
      ;;
  esac
}

build_search_query() {
  local product_name="$1"
  local top_category="$2"
  local sub_category="$3"
  local final_category="$4"

  # 1. Normalize: strip diacritics, lowercase, replace non-alnum with spaces
  local cleaned_name
  cleaned_name=$(echo "$product_name" | \
    iconv -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null | \
    tr '[:upper:]' '[:lower:]' | \
    sed 's/[^a-z0-9]/ /g' | \
    tr -s ' ')

  # 2. Drop stopwords + tokens shorter than 2 chars, keep first 6 high-signal tokens
  local filtered_tokens
  filtered_tokens=$(echo "$cleaned_name" | tr ' ' '\n' | \
    awk 'length($0) >= 2' | \
    grep -viE "$SEARCH_STOPWORDS_REGEX" | \
    head -n 6 | \
    tr '\n' ' ' | \
    sed 's/  */ /g' | \
    sed 's/^ *//;s/ *$//')

  # 3. Look up category-specific context
  local category_context
  category_context=$(category_context_for "$final_category" "$sub_category" "$top_category")

  # 4. Compose final query (tokens first so they dominate ranking)
  local query="${filtered_tokens} ${category_context}"

  # Collapse multiple spaces
  echo "$query" | sed 's/  */ /g' | sed 's/^ *//;s/ *$//'
}

############################################
# API FETCHERS
############################################
fetch_unsplash() {
  local query="$1"
  [[ "$UNSPLASH_ACTIVE" -eq 1 ]] || return 1

  local response
  response=$(curl -s --max-time "$REQUEST_TIMEOUT" \
    -H "Authorization: Client-ID ${UNSPLASH_ACCESS_KEY}" \
    "https://api.unsplash.com/search/photos?query=${query// /%20}&per_page=50&orientation=squarish&content_filter=high") || {
      UNSPLASH_ACTIVE=0
      log "Unsplash failed permanently for this run."
      return 1
    }

  local url
  url=$(echo "$response" | jq -r '.results[]?.urls.regular' | awk 'NF' | sort -R | head -n 1)

  [[ -n "$url" && "$url" != "null" ]] || return 1
  echo "$url"
}

fetch_pexels() {
  local query="$1"
  [[ "$PEXELS_ACTIVE" -eq 1 ]] || return 1

  local response
  response=$(curl -s --max-time "$REQUEST_TIMEOUT" \
    -H "Authorization: ${PEXELS_API_KEY}" \
    "https://api.pexels.com/v1/search?query=${query// /%20}&per_page=50") || {
      PEXELS_ACTIVE=0
      log "Pexels failed permanently for this run."
      return 1
    }

  local url
  url=$(echo "$response" | jq -r '.photos[]?.src.large2x' | awk 'NF' | sort -R | head -n 1)

  [[ -n "$url" && "$url" != "null" ]] || return 1
  echo "$url"
}

fetch_pixabay() {
  local query="$1"
  [[ "$PIXABAY_ACTIVE" -eq 1 ]] || return 1

  local response
  response=$(curl -s --max-time "$REQUEST_TIMEOUT" \
    "https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query// /+}&image_type=photo&per_page=50&safesearch=true") || {
      PIXABAY_ACTIVE=0
      log "Pixabay failed permanently for this run."
      return 1
    }

  local url
  url=$(echo "$response" | jq -r '.hits[]?.largeImageURL' | awk 'NF' | sort -R | head -n 1)

  [[ -n "$url" && "$url" != "null" ]] || return 1
  echo "$url"
}

get_image_url() {
  local query="$1"
  local result

  result=$(fetch_pexels "$query") && { echo "$result"; return 0; }
  result=$(fetch_unsplash "$query") && { echo "$result"; return 0; }
  result=$(fetch_pixabay "$query") && { echo "$result"; return 0; }

  return 1
}

############################################
# DOWNLOAD
############################################
download_image() {
  local image_url="$1"
  local output_path="$2"

  curl -L --fail --max-time "$REQUEST_TIMEOUT" -o "$output_path" "$image_url" >/dev/null 2>&1 || return 1

  is_valid_image "$output_path" || {
    rm -f "$output_path"
    return 1
  }

  if is_duplicate_image "$output_path"; then
    rm -f "$output_path"
    return 1
  fi

  return 0
}

############################################
# IMMEDIATE JSON UPDATE
# Append a single image key to a product's productImageKeys and persist
# back to INPUT_JSON atomically. Called after every successful download
# so an interrupted run never loses image-to-product mapping.
############################################
append_image_key_to_product() {
  local product_index="$1"
  local image_key="$2"

  local tmp_file
  tmp_file=$(mktemp)

  jq --argjson idx "$product_index" --arg key "$image_key" \
    '.products[$idx].productImageKeys = ((.products[$idx].productImageKeys // []) + [$key])' \
    "$INPUT_JSON" > "$tmp_file"

  safe_json_write "$INPUT_JSON" "$tmp_file"
}

############################################
# MAIN
############################################
TOTAL_PRODUCTS=$(jq '.products | length' "$INPUT_JSON")

log "Scanning $TOTAL_PRODUCTS products for missing images"

for ((i=0; i<TOTAL_PRODUCTS; i++)); do
  if (( TOTAL_DOWNLOADED_THIS_RUN >= MAX_IMAGES_PER_RUN )); then
    log "Reached MAX_IMAGES_PER_RUN=$MAX_IMAGES_PER_RUN"
    break
  fi

  EXISTING_COUNT=$(jq ".products[$i].productImageKeys | length" "$INPUT_JSON")

  if (( EXISTING_COUNT > 0 )); then
    log "Skipping product $i (already has $EXISTING_COUNT image(s))"
    continue
  fi

  # Use English (languageId == SEARCH_LANGUAGE_ID) translation for search
  PRODUCT_NAME=$(jq -r --argjson lang "$SEARCH_LANGUAGE_ID" \
    ".products[$i].productTranslations[] | select(.languageId == \$lang) | .name" \
    "$INPUT_JSON" | head -n 1)

  # Fallback to first available translation if English is missing
  if [[ -z "$PRODUCT_NAME" || "$PRODUCT_NAME" == "null" ]]; then
    log "Product $i has no languageId=$SEARCH_LANGUAGE_ID translation, falling back to first available"
    PRODUCT_NAME=$(jq -r ".products[$i].productTranslations[]?.name" "$INPUT_JSON" | head -n 1)
  fi

  TOP_CATEGORY=$(jq -r ".products[$i].topCategoryKey // \"\"" "$INPUT_JSON")
  SUB_CATEGORY=$(jq -r ".products[$i].subCategoryKey // \"\"" "$INPUT_JSON")
  FINAL_CATEGORY=$(jq -r ".products[$i].finalCategoryKey // \"\"" "$INPUT_JSON")

  SEARCH_TERM=$(build_search_query "$PRODUCT_NAME" "$TOP_CATEGORY" "$SUB_CATEGORY" "$FINAL_CATEGORY")

  if [[ -z "$SEARCH_TERM" ]]; then
    log "Skipping product $i (invalid search term)"
    continue
  fi

  REMAINING_SLOTS=$((MAX_IMAGES_PER_RUN - TOTAL_DOWNLOADED_THIS_RUN))
  TARGET_COUNT=$(determine_target_count "$REMAINING_SLOTS")

  log "Product $i :: name=\"$PRODUCT_NAME\" :: query=\"$SEARCH_TERM\" :: target=$TARGET_COUNT"

  for ((img=1; img<=TARGET_COUNT; img++)); do
    SUCCESS=0

    for ((attempt=1; attempt<=MAX_RETRIES_PER_IMAGE; attempt++)); do
      IMAGE_URL=$(get_image_url "$SEARCH_TERM") || true

      if [[ -z "${IMAGE_URL:-}" ]]; then
        continue
      fi

      SAFE_NAME=$(sanitize_filename "$SEARCH_TERM")
      # Include product index to guarantee filename uniqueness across products
      FILE_NAME="${SAFE_NAME}-p${i}-${img}.jpg"
      FILE_PATH="${IMAGES_DIR}/${FILE_NAME}"

      if download_image "$IMAGE_URL" "$FILE_PATH"; then
        IMAGE_KEY="public/products/${FILE_NAME}"

        # Persist immediately - if the script dies mid-product, we still
        # have the mapping for everything downloaded so far.
        if append_image_key_to_product "$i" "$IMAGE_KEY"; then
          TOTAL_DOWNLOADED_THIS_RUN=$((TOTAL_DOWNLOADED_THIS_RUN+1))
          SUCCESS=1
          log "Downloaded + persisted: $FILE_NAME (product $i)"
          sleep "$SLEEP_BETWEEN_REQUESTS"
          break
        else
          # Persisting failed; remove the orphan file to keep state consistent
          rm -f "$FILE_PATH"
          log "Persist failed for product $i img $img - removed orphan file"
        fi
      fi
    done

    if [[ "$SUCCESS" -eq 0 ]]; then
      log "Failed image $img for product $i"
    fi
  done
done

log "Completed run."
log "Source file (live-updated): $INPUT_JSON"
log "Backup (pre-run snapshot):  $BACKUP_JSON"
log "Images stored in:           $IMAGES_DIR"
log "Total downloaded this run:  $TOTAL_DOWNLOADED_THIS_RUN"
