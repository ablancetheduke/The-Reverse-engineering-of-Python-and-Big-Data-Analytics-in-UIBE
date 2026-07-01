$uri = 'https://lab.uibe.edu.cn/api/getFinaltestRanking'
$params = @{
    student_id = '2023XXXXXX'
    class_name = '2025-2026-2-CMP245-3-Python与大数据分析-XX'
    window = '39'
}
$query = ($params.GetEnumerator() | ForEach-Object {
    [uri]::EscapeDataString($_.Key) + '=' + [uri]::EscapeDataString([string]$_.Value)
}) -join '&'

Write-Host "=== Request URL ==="
Write-Host "$uri`?$query"
Write-Host ""

try {
    $r = Invoke-WebRequest -Uri ($uri + '?' + $query) -Method GET -UseBasicParsing -TimeoutSec 30
    $json = $r.Content | ConvertFrom-Json

    Write-Host "=== Ranking Results ==="
    Write-Host "Total Students: $($json.total_students)"
    Write-Host "My Rank: $($json.my_rank)"
    Write-Host "My AUC: $($json.my_auc)"
    Write-Host ""

    if ($json.above -and $json.above.Count -gt 0) {
        Write-Host "=== Above (higher ranks) ==="
        foreach ($s in $json.above) {
            Write-Host ("Rank {0,2}: {1} (masked: {2})  AUC = {3}" -f $s.rank, $s.student_id, $s.student_id_masked, $s.auc)
        }
    }

    Write-Host ""

    if ($json.below -and $json.below.Count -gt 0) {
        Write-Host "=== Below (lower ranks) ==="
        foreach ($s in $json.below) {
            Write-Host ("Rank {0,2}: {1} (masked: {2})  AUC = {3}" -f $s.rank, $s.student_id, $s.student_id_masked, $s.auc)
        }
    }

    # Save raw JSON
    $r.Content | Out-File -FilePath "$PSScriptRoot\ranking_raw.json" -Encoding UTF8
    Write-Host ""
    Write-Host "Raw JSON saved to ranking_raw.json"

} catch {
    if ($_.Exception.Response) {
        $resp = $_.Exception.Response
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $sr.ReadToEnd()
        Write-Host "HTTP Error: $($resp.StatusCode.value__) $($resp.StatusCode)"
        Write-Host "Response: $body"
    } else {
        Write-Host "Error: $($_.Exception.Message)"
    }
}
