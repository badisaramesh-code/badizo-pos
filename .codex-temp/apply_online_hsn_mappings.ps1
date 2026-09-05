param(
    [Parameter(Mandatory = $true)][string]$InputCsv,
    [Parameter(Mandatory = $true)][string]$PreviousReviewCsv,
    [Parameter(Mandatory = $true)][string]$OutputCsv,
    [Parameter(Mandatory = $true)][string]$PendingCsv
)

$ErrorActionPreference = 'Stop'
$cbicRates = 'https://cbic-gst.gov.in/gst-goods-services-rates.html'
$gstSearch = 'https://services.gst.gov.in/services/searchhsnsac'

$mappings = @(
    [pscustomobject]@{ Family='HAIR_COMB'; Pattern='\b(COMBS?|POCKET COMBS?|HAIR COMBS?)\b'; Exclude='\b(HONEY|BINDING|SPIRAL)\b'; Hsn='9615'; Source=$cbicRates; Basis='Combs and hair-slides heading 9615' },
    [pscustomobject]@{ Family='SANITARY_PAD'; Pattern='\b(WHISPER|STAYFREE|SOFY|SANITARY\s+(PAD|NAPKIN))\b'; Exclude=''; Hsn='96190010'; Source=$cbicRates; Basis='Sanitary towels/pads or sanitary napkins under 96190010/96190020' },
    [pscustomobject]@{ Family='DETERGENT'; Pattern='\b(RIN|ARIEL|SURF\s*EXCEL|TIDE|DETERGENT|WASHING\s+POWDER)\b'; Exclude='\b(SOAP|BAR)\b'; Hsn='3402'; Source=$cbicRates; Basis='Washing and cleaning preparations heading 3402' },
    [pscustomobject]@{ Family='GAS_LIGHTER'; Pattern='\bGAS\s+LIGHTERS?\b'; Exclude=''; Hsn='9613'; Source=$cbicRates; Basis='Cigarette and other lighters heading 9613' },
    [pscustomobject]@{ Family='TOOTHPASTE'; Pattern='\bTOOTH\s*PASTE\b'; Exclude=''; Hsn='33061020'; Source=$gstSearch; Basis='Dentifrices/toothpaste tariff item 33061020' },
    [pscustomobject]@{ Family='HANDWASH'; Pattern='\bHAND\s*WASH\b'; Exclude=''; Hsn='34013019'; Source=$cbicRates; Basis='Retail liquid/cream preparations for washing skin under 340130' }
)

$rows = @(Import-Csv -LiteralPath $InputCsv)
$previousReview = @(Import-Csv -LiteralPath $PreviousReviewCsv)
function Test-HsnFormat([string]$hsn) {
    if ([string]::IsNullOrWhiteSpace($hsn)) { return $false }
    $code = $hsn.Trim()
    if ($code -match '^00') { return $false }
    return $code -match '^(\d{4}|\d{6}|\d{8})$'
}

$applied = [System.Collections.Generic.List[object]]::new()
foreach ($row in $rows) {
    if (Test-HsnFormat ([string]$row.hsn_code)) { continue }
    $name = ([string]$row.product_name).ToUpperInvariant()
    foreach ($mapping in $mappings) {
        if ($name -match $mapping.Pattern -and ([string]::IsNullOrEmpty($mapping.Exclude) -or $name -notmatch $mapping.Exclude)) {
            $oldHsn = [string]$row.hsn_code
            $row.hsn_code = $mapping.Hsn
            $applied.Add([pscustomobject]@{
                product_code = $row.product_code
                barcode = $row.barcode
                product_name = $row.product_name
                previous_hsn_code = $oldHsn
                applied_hsn_code = $mapping.Hsn
                gst_percent = $row.gst_percent
                product_family = $mapping.Family
                mapping_basis = $mapping.Basis
                official_source_url = $mapping.Source
                verification_status = 'ONLINE_REFERENCE_FAMILY_MATCH'
            })
            break
        }
    }
}

$pending = @($previousReview | Where-Object {
    if ($_.verification_status -eq 'AUTO_CORRECTED_FROM_EXACT_NAME_CONSENSUS') { return $false }
    if ($_.verification_status -ne 'MANUAL_REVIEW_INVALID_OR_PLACEHOLDER') { return $true }
    $reviewName = ([string]$_.product_name).ToUpperInvariant()
    foreach ($mapping in $mappings) {
        if ($reviewName -match $mapping.Pattern -and ([string]::IsNullOrEmpty($mapping.Exclude) -or $reviewName -notmatch $mapping.Exclude)) {
            return $false
        }
    }
    return $true
})

$rows | Export-Csv -LiteralPath $OutputCsv -NoTypeInformation -Encoding utf8
$pending | Export-Csv -LiteralPath $PendingCsv -NoTypeInformation -Encoding utf8

[pscustomobject]@{
    total_rows = $rows.Count
    online_family_corrected = $applied.Count
    remaining_review_rows = $pending.Count
    family_counts = @($applied | Group-Object product_family | ForEach-Object { [pscustomobject]@{ family=$_.Name; count=$_.Count } })
    output_csv = $OutputCsv
    pending_csv = $PendingCsv
} | ConvertTo-Json -Depth 4




