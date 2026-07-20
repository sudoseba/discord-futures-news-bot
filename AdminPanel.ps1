<#
    Discord News Bot — Admin Panel
    ------------------------------------------------------------------
    A WinForms GUI to:
      * View / edit every .env key & config setting (secrets masked)
      * Live-test each API (uses the value currently in the box)
      * Start / stop / restart the bot, check /healthz, tail logs,
        and (re)register slash commands.

    Run it:  double-click Launch-AdminPanel.cmd
       or:   powershell -STA -ExecutionPolicy Bypass -File AdminPanel.ps1
#>

# ─── Ensure we're on an STA thread (WinForms requirement) ────────────────────
if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    $exe = (Get-Process -Id $PID).Path
    & $exe -NoProfile -ExecutionPolicy Bypass -STA -File $PSCommandPath
    exit
}

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ─── Paths ───────────────────────────────────────────────────────────────────
$ProjectDir = $PSScriptRoot
$EnvPath    = Join-Path $ProjectDir '.env'
$LogDir     = Join-Path $ProjectDir 'logs'
$OutLog     = Join-Path $LogDir 'bot.out.log'
$ErrLog     = Join-Path $LogDir 'bot.err.log'
$PidFile    = Join-Path $ProjectDir '.adminpanel-bot.pid'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

$ver = '2.0.0'
try { $ver = (Get-Content (Join-Path $ProjectDir 'package.json') -Raw | ConvertFrom-Json).version } catch {}

# ─── Colors ──────────────────────────────────────────────────────────────────
$ClrOk     = [System.Drawing.Color]::FromArgb(34,139,34)
$ClrFail   = [System.Drawing.Color]::FromArgb(200,40,40)
$ClrBusy   = [System.Drawing.Color]::FromArgb(120,120,120)
$ClrHeader = [System.Drawing.Color]::FromArgb(60,110,190)

# ─── Setting schema (drives the Settings tab & the .env round-trip) ──────────
# Type: text | secret | bool | choice
$Schema = @(
    @{ Key='DISCORD_TOKEN';          Label='Bot Token';          Cat='Discord';       Type='secret'; Hint='Discord Developer Portal > Bot > Token' }
    @{ Key='DISCORD_CLIENT_ID';      Label='Client / App ID';    Cat='Discord';       Type='text';   Hint='Application (client) ID' }
    @{ Key='DISCORD_CLIENT_SECRET';  Label='Client Secret';      Cat='Discord';       Type='secret'; Hint='OAuth2 client secret' }
    @{ Key='DISCORD_GUILD_ID';       Label='Guild (Server) ID';  Cat='Discord';       Type='text';   Hint='Your Discord server ID' }
    @{ Key='AUTO_POST_CHANNEL_ID';   Label='Auto-Post Channel';  Cat='Discord';       Type='text';   Hint='Channel ID for briefings/recaps/alerts' }

    @{ Key='NEWS_API_KEY';           Label='NewsAPI.org Key';    Cat='News APIs';     Type='secret'; Hint='newsapi.org' }
    @{ Key='BENZINGA_API_KEY';       Label='Benzinga Key';       Cat='News APIs';     Type='secret'; Hint='api.benzinga.com' }
    @{ Key='FINNHUB_API_KEY';        Label='Finnhub Key';        Cat='News APIs';     Type='secret'; Hint='finnhub.io (currently returning 401)' }

    @{ Key='CEREBRAS_API_KEY';       Label='Cerebras Key';       Cat='AI & Voice';    Type='secret'; Hint='cloud.cerebras.ai - the ONLY LLM the bot uses' }
    @{ Key='CEREBRAS_MODEL';         Label='Cerebras Model';     Cat='AI & Voice';    Type='text';   Default='gpt-oss-120b'; Hint='Default: gpt-oss-120b' }
    @{ Key='DEEPGRAM_TTS_API_KEY';   Label='Deepgram TTS Key';   Cat='AI & Voice';    Type='secret'; Hint='deepgram.com - recap voice audio (opt-in)' }
    @{ Key='GROQ_API_KEY';           Label='Groq Key';           Cat='AI & Voice';    Type='secret'; Hint='groq.com - automatic failover for Cerebras' }
    @{ Key='GROQ_MODEL';             Label='Groq Model';         Cat='AI & Voice';    Type='text';   Default='llama-3.3-70b-versatile'; Hint='Groq failover model' }

    @{ Key='ALPHA_VANTAGE_API_KEY';  Label='Alpha Vantage Key';  Cat='Market Data';   Type='secret'; Hint='alphavantage.co - weekly candle fallback' }
    @{ Key='MASSIVE_API_KEY';        Label='Massive Key';        Cat='Market Data';   Type='secret'; Hint='massive.com - quotes/candles fallback (real volume + VWAP)' }
    @{ Key='TWELVEDATA_API_KEY';     Label='Twelve Data Key';    Cat='Market Data';   Type='secret'; Hint='twelvedata.com - FX/metals/crypto/stocks fallback' }
    @{ Key='EXCHANGERATE_API_KEY';   Label='ExchangeRate Key';   Cat='Market Data';   Type='secret'; Hint='exchangerate-api.com - FX reference rates' }
    @{ Key='LUNARCRUSH_API_KEY';     Label='LunarCrush Key';     Cat='Market Data';   Type='secret'; Hint='lunarcrush.com - crypto social (needs paid tier)' }

    @{ Key='SCHEDULE_TIMEZONE';      Label='Timezone';           Cat='Schedules';     Type='text';   Default='America/New_York'; Hint='IANA tz, e.g. America/New_York' }
    @{ Key='BRIEFING_CRON';          Label='Morning Briefing';   Cat='Schedules';     Type='text';   Hint='cron, e.g. 0 8 * * 1-5' }
    @{ Key='RECAP_CRON';             Label='Daily Recap';        Cat='Schedules';     Type='text';   Hint='cron, e.g. 30 16 * * 1-5' }
    @{ Key='ANOMALY_SCAN_CRON';      Label='Anomaly Scan';       Cat='Schedules';     Type='text';   Hint='cron, e.g. */15 * * * *' }
    @{ Key='BREAKING_NEWS_CRON';     Label='Breaking News';      Cat='Schedules';     Type='text';   Hint='cron, e.g. */5 * * * *' }
    @{ Key='LEVEL_BREAK_CRON';       Label='Level Break';        Cat='Schedules';     Type='text';   Hint='cron, e.g. */5 * * * *' }
    @{ Key='SCORECARD_RESOLVE_CRON'; Label='Scorecard Resolve';  Cat='Schedules';     Type='text';   Hint='cron, e.g. */30 * * * *' }
    @{ Key='COT_FRIDAY_CRON';        Label='COT Friday';         Cat='Schedules';     Type='text';   Hint='cron, e.g. 30 16 * * 5' }
    @{ Key='EVENT_OUTCOME_CRON';     Label='Event Outcome';      Cat='Schedules';     Type='text';   Hint='cron, e.g. */10 * * * *' }
    @{ Key='DEADLETTER_DRAIN_CRON';  Label='Dead-letter Drain';  Cat='Schedules';     Type='text';   Hint='cron, e.g. */1 * * * *' }

    @{ Key='LLM_CACHE_TTL_MS';       Label='LLM Cache TTL (ms)'; Cat='Behavior';      Type='text';   Hint='AI output cache in ms; 0 disables. Default 1200000 (20m)' }
    @{ Key='LOG_LEVEL';              Label='Log Level';          Cat='Behavior';      Type='choice'; Choices=@('trace','debug','info','warn','error','fatal'); Default='info' }
    @{ Key='LOG_PRETTY';             Label='Pretty Logs';        Cat='Behavior';      Type='bool';   Default='true'; Hint='Pretty console logs (dev). Off = JSON (prod)' }
    @{ Key='HEALTHZ_PORT';           Label='Health Port';        Cat='Behavior';      Type='text';   Hint='HTTP health endpoint port. Default 3000' }
    @{ Key='HEALTHZ_ENABLED';        Label='Health Endpoint On'; Cat='Behavior';      Type='bool';   Default='true' }
)

# ─── APIs for the health tab ─────────────────────────────────────────────────
$Apis = @(
    @{ Id='discord';      Name='Discord (bot token)';        Kind='key'  }
    @{ Id='newsapi';      Name='NewsAPI.org';                Kind='key'  }
    @{ Id='benzinga';     Name='Benzinga';                   Kind='key'  }
    @{ Id='finnhub';      Name='Finnhub';                    Kind='key'  }
    @{ Id='cerebras';     Name='Cerebras (AI / LLM)';        Kind='key'  }
    @{ Id='deepgram';     Name='Deepgram TTS';               Kind='key'  }
    @{ Id='alphavantage'; Name='Alpha Vantage';              Kind='key'  }
    @{ Id='yahoo';        Name='Yahoo Finance (no key)';     Kind='free' }
    @{ Id='stooq';        Name='Stooq (no key)';             Kind='free' }
    @{ Id='coingecko';    Name='CoinGecko (no key)';         Kind='free' }
    @{ Id='altme';        Name='Alternative.me F&G (no key)';Kind='free' }
    @{ Id='massive';      Name='Massive.com';                Kind='key'  }
    @{ Id='twelvedata';   Name='Twelve Data';                Kind='key'  }
    @{ Id='exchangerate'; Name='ExchangeRate-API';           Kind='key'  }
    @{ Id='groq';         Name='Groq (LLM failover)';        Kind='key'  }
    @{ Id='lunarcrush';   Name='LunarCrush (crypto social)'; Kind='key'  }
    @{ Id='bybit';        Name='Bybit funding (no key)';     Kind='free' }
)

$script:Controls   = @{}
$script:HealthRows = @{}
$script:LogTimer   = $null

# ─── .env helpers ────────────────────────────────────────────────────────────
function Read-EnvValues {
    $h = @{}
    if (Test-Path $EnvPath) {
        foreach ($line in [System.IO.File]::ReadAllLines($EnvPath)) {
            $t = $line.Trim()
            if ($t -eq '' -or $t.StartsWith('#')) { continue }
            $idx = $t.IndexOf('=')
            if ($idx -lt 1) { continue }
            $h[$t.Substring(0,$idx).Trim()] = $t.Substring($idx+1)
        }
    }
    return $h
}

function Get-FieldValue([string]$key) {
    if (-not $script:Controls.ContainsKey($key)) { return '' }
    $c = $script:Controls[$key]
    if ($c -is [System.Windows.Forms.CheckBox]) { if ($c.Checked) { return 'true' } else { return 'false' } }
    return $c.Text
}

function Load-Values {
    $h = Read-EnvValues
    foreach ($s in $Schema) {
        $c = $script:Controls[$s.Key]
        $v = ''
        if ($h.ContainsKey($s.Key)) { $v = $h[$s.Key] }
        switch ($s.Type) {
            'bool'   { if ($v -eq '') { $v = $s.Default }; $c.Checked = ($v -eq 'true') }
            'choice' { if ($v -eq '') { $v = $s.Default }; $c.Text = $v }
            default  { if ($v -eq '' -and $s.ContainsKey('Default')) { $v = $s.Default }; $c.Text = $v }
        }
    }
}

function Save-Env {
    $values = @{}
    foreach ($s in $Schema) { $values[$s.Key] = (Get-FieldValue $s.Key) }
    $handled = @{}
    $orig = @()
    if (Test-Path $EnvPath) { $orig = [System.IO.File]::ReadAllLines($EnvPath) }
    $out = New-Object System.Collections.Generic.List[string]

    foreach ($line in $orig) {
        $matched = $false
        foreach ($s in $Schema) {
            $rx = '^\s*#?\s*' + [regex]::Escape($s.Key) + '\s*='
            if ($line -match $rx) {
                $val = $values[$s.Key]
                if ([string]::IsNullOrEmpty($val)) {
                    if ($line -match '^\s*#') { $out.Add($line) } else { $out.Add("$($s.Key)=") }
                } else {
                    $out.Add("$($s.Key)=$val")
                }
                $handled[$s.Key] = $true
                $matched = $true
                break
            }
        }
        if (-not $matched) { $out.Add($line) }
    }

    $missing = $Schema | Where-Object { -not $handled.ContainsKey($_.Key) -and -not [string]::IsNullOrEmpty($values[$_.Key]) }
    if ($missing) {
        $out.Add('')
        $out.Add('# --- Added by Admin Panel ---')
        foreach ($s in $missing) { $out.Add("$($s.Key)=$($values[$s.Key])") }
    }

    if (Test-Path $EnvPath) { Copy-Item $EnvPath "$EnvPath.bak" -Force }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($EnvPath, (($out -join "`r`n") + "`r`n"), $enc)
}

# ─── HTTP helper ─────────────────────────────────────────────────────────────
function Invoke-Http {
    param(
        [string]$Url,
        [string]$Method = 'GET',
        [hashtable]$Headers = $null,
        $Body = $null,
        [string]$ContentType = $null,
        [int]$TimeoutSec = 8
    )
    $p = @{ Uri=$Url; Method=$Method; TimeoutSec=$TimeoutSec; UseBasicParsing=$true; ErrorAction='Stop'; UserAgent='Mozilla/5.0 (DiscordNewsBot-AdminPanel)' }
    if ($Headers)     { $p.Headers = $Headers }
    if ($null -ne $Body) { $p.Body = $Body }
    if ($ContentType) { $p.ContentType = $ContentType }
    try {
        $r = Invoke-WebRequest @p
        return [pscustomobject]@{ Ok=$true; Code=[int]$r.StatusCode; Body=[string]$r.Content; Err=$null }
    } catch {
        $code = 0; $body = $null
        $resp = $_.Exception.Response
        if ($resp) {
            try { $code = [int]$resp.StatusCode } catch {}
            try { $st = $resp.GetResponseStream(); if ($st) { $rd = New-Object System.IO.StreamReader($st); $body = $rd.ReadToEnd(); $rd.Close() } } catch {}
        }
        if ((-not $body) -and $_.ErrorDetails) { $body = $_.ErrorDetails.Message }
        return [pscustomobject]@{ Ok=$false; Code=$code; Body=$body; Err=$_.Exception.Message }
    }
}

function Describe-HttpErr($r) {
    $m = ''
    if ($r.Body) {
        try {
            $j = $r.Body | ConvertFrom-Json
            if ($j.message)      { $m = $j.message }
            elseif ($j.error)    { if ($j.error.message) { $m = $j.error.message } else { $m = [string]$j.error } }
        } catch {}
    }
    if (-not $m) { $m = $r.Err }
    if ($r.Code -gt 0) { return "HTTP $($r.Code) - $m" }
    return $m
}

# ─── Per-API test logic ──────────────────────────────────────────────────────
function Run-ApiTest([string]$Id) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $ok = $false; $msg = ''
    try {
        switch ($Id) {
            'discord' {
                $t = Get-FieldValue 'DISCORD_TOKEN'
                if (-not $t) { $msg = 'No token set'; break }
                $r = Invoke-Http -Url 'https://discord.com/api/v10/users/@me' -Headers @{ Authorization = "Bot $t" }
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; $ok = $true; $msg = "OK - $($j.username) (id $($j.id))" }
                else { $msg = Describe-HttpErr $r }
            }
            'finnhub' {
                $k = Get-FieldValue 'FINNHUB_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url "https://finnhub.io/api/v1/quote?symbol=AAPL&token=$k"
                if ($r.Ok) {
                    $j = $r.Body | ConvertFrom-Json
                    if ($j.c -and $j.c -ne 0) { $ok = $true; $msg = "OK - AAPL `$$($j.c)" }
                    else { $msg = '200 but empty payload - key likely invalid or plan-limited' }
                } else { $msg = Describe-HttpErr $r }
            }
            'newsapi' {
                $k = Get-FieldValue 'NEWS_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url "https://newsapi.org/v2/top-headlines?category=business&country=us&pageSize=1&apiKey=$k"
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; if ($j.status -eq 'ok') { $ok = $true; $msg = "OK - $($j.totalResults) results available" } else { $msg = $j.message } }
                else { $msg = Describe-HttpErr $r }
            }
            'benzinga' {
                $k = Get-FieldValue 'BENZINGA_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url "https://api.benzinga.com/api/v2/news?token=$k&pageSize=1"
                if ($r.Ok) { $ok = $true; $msg = 'OK - endpoint responded (200)' }
                else { $msg = Describe-HttpErr $r }
            }
            'cerebras' {
                $k = Get-FieldValue 'CEREBRAS_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $model = Get-FieldValue 'CEREBRAS_MODEL'; if (-not $model) { $model = 'gpt-oss-120b' }
                # 256 tokens: gpt-oss is a reasoning model — a tiny max_tokens is fully consumed by reasoning, leaving empty content.
                $payload = @{ model=$model; messages=@(@{ role='user'; content='Reply with the single word: pong' }); max_tokens=256; temperature=0 } | ConvertTo-Json -Depth 6
                $r = Invoke-Http -Url 'https://api.cerebras.ai/v1/chat/completions' -Method POST -Headers @{ Authorization = "Bearer $k" } -Body $payload -ContentType 'application/json' -TimeoutSec 20
                if ($r.Ok) {
                    $j = $r.Body | ConvertFrom-Json
                    $content = $null
                    try { $content = $j.choices[0].message.content } catch {}
                    if ($content) { $ok = $true; $msg = "OK ($model) - replied: '$content'" }
                    else { $msg = "200 but EMPTY content <- this is the /news bug. Check model name '$model' / account quota." }
                } else { $msg = Describe-HttpErr $r }
            }
            'deepgram' {
                $k = Get-FieldValue 'DEEPGRAM_TTS_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url 'https://api.deepgram.com/v1/projects' -Headers @{ Authorization = "Token $k" }
                if ($r.Ok) { $ok = $true; $msg = 'OK - key valid (no TTS quota used)' }
                else { $msg = Describe-HttpErr $r }
            }
            'alphavantage' {
                $k = Get-FieldValue 'ALPHA_VANTAGE_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=$k"
                if ($r.Ok) {
                    $j = $r.Body | ConvertFrom-Json
                    if ($j.'Global Quote' -and $j.'Global Quote'.'05. price') { $ok = $true; $msg = "OK - IBM `$$($j.'Global Quote'.'05. price')" }
                    elseif ($j.Note)             { $msg = "Rate-limited: $($j.Note)" }
                    elseif ($j.Information)       { $msg = [string]$j.Information }
                    elseif ($j.'Error Message')  { $msg = [string]$j.'Error Message' }
                    else { $msg = 'Unexpected response (key may be invalid)' }
                } else { $msg = Describe-HttpErr $r }
            }
            'yahoo' {
                $r = Invoke-Http -Url 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d'
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; $pr = $null; try { $pr = $j.chart.result[0].meta.regularMarketPrice } catch {}; $ok = $true; if ($pr) { $msg = "OK - AAPL `$$pr" } else { $msg = 'OK (200)' } }
                else { $msg = Describe-HttpErr $r }
            }
            'stooq' {
                $r = Invoke-Http -Url 'https://stooq.com/q/d/l/?s=aapl.us&i=d'
                if ($r.Ok) { if ($r.Body -match '^Date') { $ok = $true; $msg = 'OK - CSV received' } else { $msg = '200 but unexpected body' } }
                else { $msg = Describe-HttpErr $r }
            }
            'coingecko' {
                $r = Invoke-Http -Url 'https://api.coingecko.com/api/v3/ping'
                if ($r.Ok) { $ok = $true; $msg = 'OK - ping' } else { $msg = Describe-HttpErr $r }
            }
            'altme' {
                $r = Invoke-Http -Url 'https://api.alternative.me/fng/?limit=1'
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; $ok = $true; $msg = "OK - Fear&Greed $($j.data[0].value) ($($j.data[0].value_classification))" }
                else { $msg = Describe-HttpErr $r }
            }
            'twelvedata' {
                $k = Get-FieldValue 'TWELVEDATA_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url "https://api.twelvedata.com/quote?symbol=AAPL&apikey=$k"
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; if ($j.close) { $ok = $true; $msg = "OK - AAPL `$$($j.close)" } else { $msg = [string]$j.message } }
                else { $msg = Describe-HttpErr $r }
            }
            'massive' {
                $k = Get-FieldValue 'MASSIVE_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url "https://api.massive.com/v2/aggs/ticker/AAPL/prev?apiKey=$k"
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; if ($j.status -eq 'OK' -and $j.results) { $ok = $true; $msg = "OK - AAPL prev `$$($j.results[0].c)" } else { $msg = 'Unexpected response (check key/plan)' } }
                else { $msg = Describe-HttpErr $r }
            }
            'exchangerate' {
                $k = Get-FieldValue 'EXCHANGERATE_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url "https://v6.exchangerate-api.com/v6/$k/pair/EUR/USD"
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; if ($j.result -eq 'success') { $ok = $true; $msg = "OK - EUR/USD $($j.conversion_rate)" } else { $msg = [string]$j.'error-type' } }
                else { $msg = Describe-HttpErr $r }
            }
            'groq' {
                $k = Get-FieldValue 'GROQ_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url 'https://api.groq.com/openai/v1/models' -Headers @{ Authorization = "Bearer $k" }
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; $ok = $true; $msg = "OK - $(@($j.data).Count) models available" }
                else { $msg = Describe-HttpErr $r }
            }
            'lunarcrush' {
                $k = Get-FieldValue 'LUNARCRUSH_API_KEY'
                if (-not $k) { $msg = 'No key set'; break }
                $r = Invoke-Http -Url 'https://lunarcrush.com/api4/public/coins/BTC/v1' -Headers @{ Authorization = "Bearer $k" }
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; if ($j.data) { $ok = $true; $msg = 'OK - data received' } else { $msg = [string]$j.error } }
                else { $msg = Describe-HttpErr $r }
            }
            'bybit' {
                $r = Invoke-Http -Url 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT'
                if ($r.Ok) { $j = $r.Body | ConvertFrom-Json; if ($j.retCode -eq 0) { $ok = $true; $msg = "OK - BTC funding $($j.result.list[0].fundingRate)" } else { $msg = [string]$j.retMsg } }
                else { $msg = Describe-HttpErr $r }
            }
            default { $msg = 'No test defined' }
        }
    } catch {
        $msg = "Test error: $($_.Exception.Message)"
    }
    $sw.Stop()
    return @{ Ok=$ok; Msg=$msg; Ms=[int]$sw.ElapsedMilliseconds }
}

function Do-HealthTest([string]$Id) {
    $row = $script:HealthRows[$Id]
    if (-not $row) { return }
    $row.Status.Text = '...'; $row.Status.ForeColor = $ClrBusy
    $row.Detail.Text = 'testing...'
    [System.Windows.Forms.Application]::DoEvents()
    $res = Run-ApiTest $Id
    if ($res.Ok) { $row.Status.Text = 'OK';   $row.Status.ForeColor = $ClrOk }
    else         { $row.Status.Text = 'FAIL'; $row.Status.ForeColor = $ClrFail }
    $row.Detail.Text = "$($res.Msg)   ($($res.Ms) ms)"
}

# ─── Bot process helpers ─────────────────────────────────────────────────────
function Test-BotAlive {
    if (-not (Test-Path $PidFile)) { return $false }
    try { $procId = [int](Get-Content $PidFile -Raw).Trim() } catch { return $false }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    return [bool]$p
}

function Test-HealthResponding {
    $port = Get-FieldValue 'HEALTHZ_PORT'; if (-not $port) { $port = '3000' }
    $r = Invoke-Http -Url "http://localhost:$port/healthz" -TimeoutSec 3
    return ($r.Ok -or $r.Code -eq 503)
}

# ══════════════════════════════════════════════════════════════════════════════
#  BUILD UI
# ══════════════════════════════════════════════════════════════════════════════
$form = New-Object System.Windows.Forms.Form
$form.Text = "Discord News Bot - Admin Panel (v$ver)"
$form.Size = New-Object System.Drawing.Size(910, 760)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.MinimumSize = New-Object System.Drawing.Size(760, 560)

$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Bottom'
$status.Height = 26
$status.TextAlign = 'MiddleLeft'
$status.BackColor = [System.Drawing.Color]::FromArgb(238,238,240)
$status.Padding = New-Object System.Windows.Forms.Padding(8,0,0,0)
$status.Text = "Project: $ProjectDir"
$form.Controls.Add($status)
function Set-Status([string]$t) { $status.Text = $t; [System.Windows.Forms.Application]::DoEvents() }

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'
$form.Controls.Add($tabs)
$tabs.BringToFront()

$tt = New-Object System.Windows.Forms.ToolTip
$tt.AutoPopDelay = 15000; $tt.InitialDelay = 400; $tt.ReshowDelay = 100

# ─── TAB 1: Settings ─────────────────────────────────────────────────────────
$tabSettings = New-Object System.Windows.Forms.TabPage
$tabSettings.Text = '  Settings  '
$tabs.TabPages.Add($tabSettings)

$setBar = New-Object System.Windows.Forms.Panel
$setBar.Dock = 'Bottom'; $setBar.Height = 46; $setBar.BackColor = [System.Drawing.Color]::FromArgb(246,246,248)
$tabSettings.Controls.Add($setBar)

$chkShow = New-Object System.Windows.Forms.CheckBox
$chkShow.Text = 'Show secrets'; $chkShow.AutoSize = $true
$chkShow.Location = New-Object System.Drawing.Point(12,13)
$chkShow.Add_CheckedChanged({
    foreach ($k in $script:Controls.Keys) {
        $c = $script:Controls[$k]
        if ($c -is [System.Windows.Forms.TextBox] -and $c.Tag -eq 'secret') { $c.UseSystemPasswordChar = -not $chkShow.Checked }
    }
})
$setBar.Controls.Add($chkShow)

$btnSave = New-Object System.Windows.Forms.Button
$btnSave.Text = 'Save to .env'; $btnSave.Size = New-Object System.Drawing.Size(110,28)
$btnSave.Location = New-Object System.Drawing.Point(150,9)
$btnSave.BackColor = [System.Drawing.Color]::FromArgb(60,110,190); $btnSave.ForeColor = 'White'; $btnSave.FlatStyle = 'Flat'
$btnSave.Add_Click({
    try {
        Save-Env
        Set-Status "Saved to .env at $(Get-Date -Format 'HH:mm:ss') (backup: .env.bak). Restart the bot to apply."
        [System.Windows.Forms.MessageBox]::Show("Settings written to .env`n(backup saved as .env.bak).`n`nRestart the bot from the 'Bot Control' tab to apply.", 'Saved', 'OK', 'Information') | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Save failed:`n$($_.Exception.Message)", 'Error', 'OK', 'Error') | Out-Null
    }
})
$setBar.Controls.Add($btnSave)

$btnReload = New-Object System.Windows.Forms.Button
$btnReload.Text = 'Reload'; $btnReload.Size = New-Object System.Drawing.Size(80,28)
$btnReload.Location = New-Object System.Drawing.Point(270,9)
$btnReload.Add_Click({ Load-Values; Set-Status 'Reloaded values from .env' })
$setBar.Controls.Add($btnReload)

$btnBackup = New-Object System.Windows.Forms.Button
$btnBackup.Text = 'Backup .env'; $btnBackup.Size = New-Object System.Drawing.Size(100,28)
$btnBackup.Location = New-Object System.Drawing.Point(358,9)
$btnBackup.Add_Click({
    if (Test-Path $EnvPath) {
        $dest = "$EnvPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $EnvPath $dest -Force
        Set-Status "Backup saved: $(Split-Path $dest -Leaf)"
    } else { Set-Status 'No .env file to back up' }
})
$setBar.Controls.Add($btnBackup)

$setPanel = New-Object System.Windows.Forms.Panel
$setPanel.Dock = 'Fill'; $setPanel.AutoScroll = $true; $setPanel.Padding = New-Object System.Windows.Forms.Padding(4)
$tabSettings.Controls.Add($setPanel)
$setPanel.BringToFront()

$y = 12; $lastCat = ''
foreach ($s in $Schema) {
    if ($s.Cat -ne $lastCat) {
        $hdr = New-Object System.Windows.Forms.Label
        $hdr.Text = $s.Cat; $hdr.AutoSize = $true
        $hdr.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
        $hdr.ForeColor = $ClrHeader
        $hdr.Location = New-Object System.Drawing.Point(10, $y)
        $setPanel.Controls.Add($hdr)
        $y += 30; $lastCat = $s.Cat
    }
    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $s.Label
    $lbl.Location = New-Object System.Drawing.Point(22, ($y + 4))
    $lbl.Size = New-Object System.Drawing.Size(230, 20)
    $setPanel.Controls.Add($lbl)

    switch ($s.Type) {
        'bool' {
            $c = New-Object System.Windows.Forms.CheckBox
            $c.Location = New-Object System.Drawing.Point(262, $y)
            $c.Size = New-Object System.Drawing.Size(80, 24)
        }
        'choice' {
            $c = New-Object System.Windows.Forms.ComboBox
            $c.DropDownStyle = 'DropDownList'
            $c.Location = New-Object System.Drawing.Point(262, $y)
            $c.Size = New-Object System.Drawing.Size(360, 24)
            foreach ($ch in $s.Choices) { [void]$c.Items.Add($ch) }
        }
        default {
            $c = New-Object System.Windows.Forms.TextBox
            $c.Location = New-Object System.Drawing.Point(262, $y)
            $c.Size = New-Object System.Drawing.Size(360, 24)
            if ($s.Type -eq 'secret') { $c.UseSystemPasswordChar = $true; $c.Tag = 'secret' }
        }
    }
    $setPanel.Controls.Add($c)
    $script:Controls[$s.Key] = $c
    if ($s.Hint) { $tt.SetToolTip($c, $s.Hint); $tt.SetToolTip($lbl, $s.Hint) }
    $y += 32
}
$setPanel.AutoScrollMinSize = New-Object System.Drawing.Size(640, ($y + 10))

# ─── TAB 2: API Health ───────────────────────────────────────────────────────
$tabHealth = New-Object System.Windows.Forms.TabPage
$tabHealth.Text = '  API Health  '
$tabs.TabPages.Add($tabHealth)

$hTop = New-Object System.Windows.Forms.Panel
$hTop.Dock = 'Top'; $hTop.Height = 64
$tabHealth.Controls.Add($hTop)

$btnTestAll = New-Object System.Windows.Forms.Button
$btnTestAll.Text = 'Test All APIs'; $btnTestAll.Size = New-Object System.Drawing.Size(130,30)
$btnTestAll.Location = New-Object System.Drawing.Point(12,10)
$btnTestAll.BackColor = [System.Drawing.Color]::FromArgb(60,110,190); $btnTestAll.ForeColor = 'White'; $btnTestAll.FlatStyle = 'Flat'
$btnTestAll.Add_Click({
    $btnTestAll.Enabled = $false
    try {
        foreach ($a in $Apis) { if ($a.Kind -ne 'note') { Set-Status "Testing $($a.Name)..."; Do-HealthTest $a.Id } }
        Set-Status "All API tests complete at $(Get-Date -Format 'HH:mm:ss')"
    } finally { $btnTestAll.Enabled = $true }
})
$hTop.Controls.Add($btnTestAll)

$hNote = New-Object System.Windows.Forms.Label
$hNote.Text = "Tests use the values currently in the Settings tab (so you can test a key before saving). Keyless sources just check connectivity."
$hNote.AutoSize = $false; $hNote.Location = New-Object System.Drawing.Point(152,8); $hNote.Size = New-Object System.Drawing.Size(720,46)
$hNote.ForeColor = [System.Drawing.Color]::DimGray
$hTop.Controls.Add($hNote)

$hPanel = New-Object System.Windows.Forms.Panel
$hPanel.Dock = 'Fill'; $hPanel.AutoScroll = $true
$tabHealth.Controls.Add($hPanel)
$hPanel.BringToFront()

$hy = 10
foreach ($a in $Apis) {
    $nameLbl = New-Object System.Windows.Forms.Label
    $nameLbl.Text = $a.Name
    $nameLbl.Location = New-Object System.Drawing.Point(15, ($hy + 5))
    $nameLbl.Size = New-Object System.Drawing.Size(230, 20)
    $hPanel.Controls.Add($nameLbl)

    $stat = New-Object System.Windows.Forms.Label
    $stat.Text = '-'; $stat.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    $stat.Location = New-Object System.Drawing.Point(250, ($hy + 5))
    $stat.Size = New-Object System.Drawing.Size(60, 20)
    $hPanel.Controls.Add($stat)

    $det = New-Object System.Windows.Forms.Label
    $det.Text = ''; $det.AutoEllipsis = $true
    $det.Location = New-Object System.Drawing.Point(315, ($hy + 5))
    $det.Size = New-Object System.Drawing.Size(440, 34)
    $hPanel.Controls.Add($det)

    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = 'Test'; $btn.Size = New-Object System.Drawing.Size(70, 26)
    $btn.Location = New-Object System.Drawing.Point(766, $hy)
    if ($a.Kind -eq 'note') {
        $btn.Enabled = $false; $stat.Text = 'n/a'; $stat.ForeColor = $ClrBusy
        $det.Text = 'Declared in .env but never referenced by the bot code (safe to ignore/remove).'
    } else {
        $thisId = $a.Id
        $btn.Add_Click(({ Do-HealthTest $thisId }).GetNewClosure())
    }
    $hPanel.Controls.Add($btn)

    $script:HealthRows[$a.Id] = @{ Status=$stat; Detail=$det; Button=$btn }
    $hy += 42
}
$hPanel.AutoScrollMinSize = New-Object System.Drawing.Size(840, ($hy + 10))

# ─── TAB 3: Bot Control ──────────────────────────────────────────────────────
$tabBot = New-Object System.Windows.Forms.TabPage
$tabBot.Text = '  Bot Control  '
$tabs.TabPages.Add($tabBot)

$bTop = New-Object System.Windows.Forms.Panel
$bTop.Dock = 'Top'; $bTop.Height = 132
$tabBot.Controls.Add($bTop)

function New-BotButton($text,$x,$y,$w) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x,$y); $b.Size = New-Object System.Drawing.Size($w,32)
    $bTop.Controls.Add($b)
    return $b
}

$btnStart   = New-BotButton 'Start Bot'          12  10 100
$btnStop    = New-BotButton 'Stop Bot'          120  10 100
$btnRestart = New-BotButton 'Restart'           228  10 90
$btnHealth  = New-BotButton 'Check /healthz'    326  10 120
$btnDeploy  = New-BotButton 'Register Commands' 454  10 150
$btnOpenEnv = New-BotButton 'Open .env'          12  50 100
$btnOpenLog = New-BotButton 'Open Logs Folder'  120  50 130

$chkAuto = New-Object System.Windows.Forms.CheckBox
$chkAuto.Text = 'Auto-refresh log'; $chkAuto.AutoSize = $true
$chkAuto.Location = New-Object System.Drawing.Point(262,56)
$bTop.Controls.Add($chkAuto)

$btnRefresh = New-BotButton 'Refresh Log' 400 50 100

# ─── Web dashboard controls (separate service; local process on Windows) ──────
$WebDir     = Join-Path $ProjectDir 'web'
$WebPidFile = Join-Path $ProjectDir '.adminpanel-web.pid'
function Get-WebUrl {
    $we = Join-Path $WebDir '.env'
    $port = '8080'; $url = ''
    if (Test-Path $we) {
        $lines = Get-Content $we
        foreach ($l in $lines) {
            if ($l -match '^\s*WEB_PORT\s*=\s*(\d+)')       { $port = $Matches[1] }
            if ($l -match '^\s*WEB_PUBLIC_URL\s*=\s*(\S+)')  { $url  = $Matches[1] }
        }
    }
    if (-not $url) { $url = "http://localhost:$port" }
    return $url
}
$btnWebStart = New-BotButton 'Start Web UI'  12  90 110
$btnWebStop  = New-BotButton 'Stop Web UI'  128  90 110
$btnWebOpen  = New-BotButton 'Open Web UI'  244  90 110

$btnWebStart.Add_Click({
    if (-not (Test-Path (Join-Path $WebDir 'node_modules'))) {
        [System.Windows.Forms.MessageBox]::Show("Web dependencies not installed.`n`nIn a terminal:`n  cd web`n  npm ci --omit=dev`n  copy .env.example .env", 'Web dashboard', 'OK', 'Warning') | Out-Null
        return
    }
    if (-not (Test-Path (Join-Path $WebDir '.env'))) {
        [System.Windows.Forms.MessageBox]::Show("web\.env is missing. Copy web\.env.example to web\.env and set SESSION_SECRET.", 'Web dashboard', 'OK', 'Warning') | Out-Null
        return
    }
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
        $wout = Join-Path $LogDir 'web.out.log'; $werr = Join-Path $LogDir 'web.err.log'
        $proc = Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory $WebDir `
                    -RedirectStandardOutput $wout -RedirectStandardError $werr -WindowStyle Hidden -PassThru
        Set-Content -Path $WebPidFile -Value $proc.Id
        Set-Status "Web dashboard started (PID $($proc.Id)) - open $(Get-WebUrl)"
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Failed to start web dashboard:`n$($_.Exception.Message)`n`nIs Node.js on PATH?", 'Error', 'OK', 'Error') | Out-Null
    }
})
$btnWebStop.Add_Click({
    if (-not (Test-Path $WebPidFile)) { Set-Status 'No web dashboard PID tracked by this panel.'; return }
    try {
        $procId = [int](Get-Content $WebPidFile -Raw).Trim()
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Remove-Item $WebPidFile -Force -ErrorAction SilentlyContinue
        Set-Status "Web dashboard stopped (PID $procId)"
    } catch {
        Remove-Item $WebPidFile -Force -ErrorAction SilentlyContinue
        Set-Status "Web stop: $($_.Exception.Message)"
    }
})
$btnWebOpen.Add_Click({ try { Start-Process (Get-WebUrl) } catch { Set-Status "Open failed: $($_.Exception.Message)" } })

$botStatus = New-Object System.Windows.Forms.Label
$botStatus.Dock = 'Top'; $botStatus.Height = 26; $botStatus.TextAlign = 'MiddleLeft'
$botStatus.Padding = New-Object System.Windows.Forms.Padding(8,0,0,0)
$botStatus.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$botStatus.Text = 'Status: unknown'
$tabBot.Controls.Add($botStatus)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true; $logBox.ReadOnly = $true; $logBox.ScrollBars = 'Both'; $logBox.WordWrap = $false
$logBox.Dock = 'Fill'; $logBox.BackColor = [System.Drawing.Color]::FromArgb(24,24,28); $logBox.ForeColor = [System.Drawing.Color]::Gainsboro
$logBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$tabBot.Controls.Add($logBox)
$logBox.BringToFront()
$botStatus.BringToFront()
$bTop.BringToFront()

function Update-BotStatus {
    if (Test-BotAlive) {
        $procId = (Get-Content $PidFile -Raw).Trim()
        $botStatus.Text = "Status: RUNNING (tracked PID $procId)"; $botStatus.ForeColor = $ClrOk
    } elseif (Test-HealthResponding) {
        $botStatus.Text = 'Status: RUNNING (untracked - started outside this panel; /healthz is up)'; $botStatus.ForeColor = $ClrOk
    } else {
        $botStatus.Text = 'Status: STOPPED'; $botStatus.ForeColor = $ClrFail
    }
}

function Refresh-Log {
    if (Test-Path $OutLog) {
        try {
            $tailLines = Get-Content $OutLog -Tail 400 -ErrorAction Stop
            $logBox.Text = ($tailLines -join "`r`n")
            $logBox.SelectionStart = $logBox.Text.Length
            $logBox.ScrollToCaret()
        } catch { }
    } else {
        $logBox.Text = "(no log yet - start the bot from this panel to capture logs to logs\bot.out.log)"
    }
}

$btnStart.Add_Click({
    if (Test-BotAlive) { [System.Windows.Forms.MessageBox]::Show('Bot already running (tracked PID).', 'Already running', 'OK', 'Information') | Out-Null; return }
    if (Test-HealthResponding) {
        $ans = [System.Windows.Forms.MessageBox]::Show("A bot instance already appears to be running (the /healthz endpoint responded).`n`nStarting another will double-post and conflict on the health port. Start anyway?", 'Warning', 'YesNo', 'Warning')
        if ($ans -ne 'Yes') { return }
    }
    try {
        $proc = Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory $ProjectDir `
                    -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -WindowStyle Hidden -PassThru
        Set-Content -Path $PidFile -Value $proc.Id
        Set-Status "Bot started (PID $($proc.Id))"
        Start-Sleep -Milliseconds 800
        Update-BotStatus; Refresh-Log
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Failed to start bot:`n$($_.Exception.Message)`n`nIs Node.js on PATH?", 'Error', 'OK', 'Error') | Out-Null
    }
})

$btnStop.Add_Click({
    if (-not (Test-Path $PidFile)) {
        [System.Windows.Forms.MessageBox]::Show('No bot PID tracked by this panel. If the bot was started elsewhere (terminal / npm), stop it there.', 'Nothing to stop', 'OK', 'Information') | Out-Null
        return
    }
    try {
        $procId = [int](Get-Content $PidFile -Raw).Trim()
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        Set-Status "Bot stopped (PID $procId)"
    } catch {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        Set-Status "Stop: $($_.Exception.Message)"
    }
    Update-BotStatus
})

$btnRestart.Add_Click({
    $btnStop.PerformClick()
    Start-Sleep -Milliseconds 700
    $btnStart.PerformClick()
})

$btnHealth.Add_Click({
    $port = Get-FieldValue 'HEALTHZ_PORT'; if (-not $port) { $port = '3000' }
    $r = Invoke-Http -Url "http://localhost:$port/healthz" -TimeoutSec 4
    if ($r.Body) {
        try {
            $j = $r.Body | ConvertFrom-Json
            $cron = 0; if ($j.cronJobs) { $cron = @($j.cronJobs).Count }
            $lines = @(
                "status      : $($j.status)",
                "uptime      : $($j.uptimeSec) s",
                "discordReady: $($j.discordReady)",
                "dbOk        : $($j.dbOk)",
                "memory      : $($j.memoryRssMb) MB",
                "pid         : $($j.pid)",
                "version     : $($j.version)",
                "cron jobs   : $cron"
            )
            $logBox.Text = "=== /healthz @ $(Get-Date -Format 'HH:mm:ss') ===`r`n" + ($lines -join "`r`n")
            Set-Status "Health: $($j.status) (uptime $($j.uptimeSec)s)"
        } catch { $logBox.Text = $r.Body }
    } else {
        Set-Status 'Health endpoint not responding - bot likely stopped.'
        $logBox.Text = "No response from http://localhost:$port/healthz`r`n$($r.Err)"
    }
})

$btnDeploy.Add_Click({
    $ans = [System.Windows.Forms.MessageBox]::Show('Register/refresh slash commands with Discord now? (runs src/deploy-commands.js)', 'Register commands', 'YesNo', 'Question')
    if ($ans -ne 'Yes') { return }
    Set-Status 'Registering slash commands...'
    Push-Location $ProjectDir
    try {
        $out = & node 'src/deploy-commands.js' 2>&1 | Out-String
        $logBox.Text = "=== deploy-commands @ $(Get-Date -Format 'HH:mm:ss') ===`r`n$out"
        Set-Status 'Slash command registration finished (see log).'
    } catch {
        $logBox.Text = "deploy-commands failed:`r`n$($_.Exception.Message)"
    } finally { Pop-Location }
})

$btnOpenEnv.Add_Click({ if (Test-Path $EnvPath) { Start-Process notepad.exe $EnvPath } else { Set-Status 'No .env file found' } })
$btnOpenLog.Add_Click({ Start-Process explorer.exe $LogDir })
$btnRefresh.Add_Click({ Refresh-Log })

# Auto-refresh timer for logs
$script:LogTimer = New-Object System.Windows.Forms.Timer
$script:LogTimer.Interval = 2500
$script:LogTimer.Add_Tick({ if ($chkAuto.Checked) { Refresh-Log; Update-BotStatus } })
$chkAuto.Add_CheckedChanged({ if ($chkAuto.Checked) { $script:LogTimer.Start() } else { $script:LogTimer.Stop() } })

# ─── Init ────────────────────────────────────────────────────────────────────
Load-Values
Update-BotStatus
Refresh-Log

$form.Add_Shown({ $form.Activate() })
$form.Add_FormClosing({ if ($script:LogTimer) { $script:LogTimer.Stop() } })
[void]$form.ShowDialog()
