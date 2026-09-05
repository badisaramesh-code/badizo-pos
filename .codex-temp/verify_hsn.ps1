param(
    [Parameter(Mandatory = $true)][string]$InputCsv,
    [Parameter(Mandatory = $true)][string]$OutputCsv,
    [Parameter(Mandatory = $true)][string]$ReviewCsv
)

$ErrorActionPreference = 'Stop'
$officialSource = 'https://www.icegate.gov.in/Webappl/Trade-Guide-on-Imports'

function Normalize-ProductName([string]$name) {
    if ([string]::IsNullOrWhiteSpace($name)) { return '' }
    $normalized = $name.ToUpperInvariant().Trim()
    $normalized = [regex]::Replace($normalized, '[^A-Z0-9]+', ' ')
    return [regex]::Replace($normalized, '\s+', ' ').Trim()
}

function Test-HsnFormat([string]$hsn) {
    if ([string]::IsNullOrWhiteSpace($hsn)) { return $false }
    $code = $hsn.Trim()
    if ($code -match '^00') { return $false }
    return $code -match '^(\d{4}|\d{6}|\d{8})$'
}

$rows = @(Import-Csv -LiteralPath $InputCsv)
$evidence = @{}

foreach ($row in $rows) {
    $nameKey = Normalize-ProductName $row.product_name
    $hsn = ([string]$row.hsn_code).Trim()
    if ($nameKey -and (Test-HsnFormat $hsn)) {
        if (-not $evidence.ContainsKey($nameKey)) { $evidence[$nameKey] = @{} }
        if (-not $evidence[$nameKey].ContainsKey($hsn)) { $evidence[$nameKey][$hsn] = 0 }
        $evidence[$nameKey][$hsn]++
    }
}

$consensus = @{}
foreach ($nameKey in $evidence.Keys) {
    $ranked = @($evidence[$nameKey].GetEnumerator() | Sort-Object @{ Expression = 'Value'; Descending = $true }, @{ Expression = 'Name'; Ascending = $true })
    $total = ($ranked | Measure-Object -Property Value -Sum).Sum
    $top = $ranked[0]
    $ratio = if ($total -gt 0) { [double]$top.Value / $total } else { 0 }
    if ($top.Value -ge 2 -and $ratio -ge 0.90) {
        $consensus[$nameKey] = [pscustomobject]@{ Hsn = [string]$top.Name; Count = [int]$top.Value; Total = [int]$total; Ratio = $ratio }
    }
}

$review = [System.Collections.Generic.List[object]]::new()
$correctedCount = 0
$invalidCount = 0
$conflictCount = 0

foreach ($row in $rows) {
    $nameKey = Normalize-ProductName $row.product_name
    $originalHsn = ([string]$row.hsn_code).Trim()
    $formatValid = Test-HsnFormat $originalHsn
    $status = 'FORMAT_VALID_NOT_TARIFF_VERIFIED'
    $suggested = ''
    $reason = ''
    $evidenceCount = 0
    $evidenceTotal = 0

    if (-not $formatValid) {
        $invalidCount++
        if ($nameKey -and $consensus.ContainsKey($nameKey)) {
            $match = $consensus[$nameKey]
            $suggested = $match.Hsn
            $evidenceCount = $match.Count
            $evidenceTotal = $match.Total
            $row.hsn_code = $suggested
            $status = 'AUTO_CORRECTED_FROM_EXACT_NAME_CONSENSUS'
            $reason = "Original HSN is blank/invalid; exact normalized product name has >=90% consensus from at least 2 valid rows."
            $correctedCount++
        } else {
            $status = 'MANUAL_REVIEW_INVALID_OR_PLACEHOLDER'
            $reason = 'HSN is blank, starts with 00, or is not 4/6/8 numeric digits; no strong exact-name consensus exists.'
        }
    } elseif ($nameKey -and $evidence.ContainsKey($nameKey) -and $evidence[$nameKey].Count -gt 1) {
        $status = 'MANUAL_REVIEW_NAME_HSN_CONFLICT'
        $reason = 'The same normalized product name is assigned more than one format-valid HSN in the source data.'
        $conflictCount++
    }

    if ($status -ne 'FORMAT_VALID_NOT_TARIFF_VERIFIED') {
        $review.Add([pscustomobject]@{
            product_code = $row.product_code
            barcode = $row.barcode
            product_name = $row.product_name
            original_hsn_code = $originalHsn
            suggested_or_applied_hsn_code = $suggested
            gst_percent = $row.gst_percent
            verification_status = $status
            verification_reason = $reason
            exact_name_evidence_count = $evidenceCount
            exact_name_valid_rows = $evidenceTotal
            official_verification_url = $officialSource
        })
    }
}

$rows | Export-Csv -LiteralPath $OutputCsv -NoTypeInformation -Encoding utf8
$review | Export-Csv -LiteralPath $ReviewCsv -NoTypeInformation -Encoding utf8

[pscustomobject]@{
    total_rows = $rows.Count
    auto_corrected = $correctedCount
    invalid_or_placeholder_total = $invalidCount
    valid_name_conflict_rows = $conflictCount
    review_rows = $review.Count
    output_csv = $OutputCsv
    review_csv = $ReviewCsv
} | ConvertTo-Json

