param([Parameter(Mandatory=$true)][string]$GameRoot, [Parameter(Mandatory=$true)][string]$OutputDirectory, [string]$PluginPath = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$plugin = Join-Path $projectRoot 'resources/player-capture/OGKToolBox.PlayerCapture.dll'
if ($PluginPath) { $plugin = [IO.Path]::GetFullPath($PluginPath) }
$core = Join-Path $projectRoot 'resources/hdd-setup/mod/BepInEx/core'
# Resolve the plugin's existing Unity/BepInEx references only. No game protocol
# assembly is loaded, no plugin instance is constructed and no game is launched.
foreach ($file in @((Join-Path $GameRoot 'mu3_Data/Managed/UnityEngine.dll'), (Join-Path $core '0Harmony20.dll'), (Join-Path $core 'BepInEx.dll'))) {
    [Reflection.Assembly]::LoadFrom($file) | Out-Null
}
$assembly = [Reflection.Assembly]::LoadFrom($plugin)
$type = $assembly.GetType('PlayerCapture', $true)
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$supportsUpsertProgress = $null -ne $type.GetMethod('WriteUpsertProgress', $flags)
$methods = @{}
foreach ($name in @('ReadMachineSnapshot','Login','WriteIdentity','Fingerprints','BeforeAcceptedSave','AfterSerialIncrement','AfterNativeSave','TryObserveMachineFlush','ReadMachineObservation','ReadPreviewResponse','PreviewResponseMethod','PreviewAgentMethod','PreviewPlayer','PreviewUserAgent','WritePreviewObservation','IsCaptureReadName','UpsertRequestMethod','RememberUpsertQuery','UpsertOwnerMatches','UpsertQueryLifetime','ReadUpsertRequest','UpsertUserAgent','ReadUpsertResponse','Connect','BeginPacket','EndPacket','UpsertHttpFactoryMethod','UpsertHttpRequestMethod','UpsertHttpCompletedMethod','UpsertResetMethod','CreatedUpsertClient','BeforeUpsertTransportRequest','AfterUpsertTransportCompleted','BeginUpsertReset','EndUpsertReset','FinalizeUpsertReset','WriteUpsertDiagnostics','PruneUpsertWitnesses')) { $methods[$name] = $type.GetMethod($name, $flags) }
$fields = @{}
foreach ($name in @('root','machineSnapshot','loginPlayer','loginIdentity','session','machineHooks','gameRoot','startupFingerprints','backupFile','nativeBackup','pendingMachine','Names','previewHooks','previewSequence','PreviewConnections','Connections','sequence','player','status','upsertHooks','upsertSequence','upsertRequestBytes','UpsertObservations','UpsertLifetimes','loginCard','loginClient','loginGeneration','loginSaveAccepted','resetContextActive','resetUpsertQuery','activeQuery','UpsertClientWitnesses','lastClientWitness','lastUpsertReason','transportSendEntries','transportCompletedEntries','transportBoundSends','transportBoundCompletions','transportRetiredSends','transportRetiredCompletions')) { $fields[$name] = $type.GetField($name, $flags) }
Add-Type -TypeDefinition @'
public sealed class CaptureFakeRequest {
    public long userId = 42;
    public string accessCode = "10000000000000000001";
    public string clientId = "A1234567890";
    public string unrelated = "must-not-be-captured";
}
public sealed class CaptureFakeResponse { public object returnCode = 1; }
public sealed class CaptureFakeLogin {
    public CaptureFakeRequest request_ = new CaptureFakeRequest();
    public CaptureFakeResponse response_ = new CaptureFakeResponse();
}
namespace MU3.Client {
    public interface INetQuery {}
    public sealed class UpsertUserAll : INetQuery {
        public CaptureFakeRequest request_ = new CaptureFakeRequest();
        public CaptureFakeUpsertResponse response_ = new CaptureFakeUpsertResponse();
        public string getRequest() { throw new System.InvalidOperationException("Observer must never call getRequest"); }
        public bool setResponse(string value) { throw new System.InvalidOperationException("Observer must never call setResponse"); }
        public override bool Equals(object value) { return value is UpsertUserAll; }
        public override int GetHashCode() { return 1; }
    }
}
public sealed class CaptureFakeUpsertResponse { public object returnCode = 1; }
public sealed class CaptureFakeWrongUpsert { public int getRequest() { return 1; } }
public static class CaptureFakeStaticUpsert { public static string getRequest() { return "not-invoked"; } }
public sealed class CaptureFakePreviewResponse {
    public object userId = (long)42;
    public object isLogin = false;
    public object isWarningConfirmed = true;
    public object banStatus = 0;
}
public sealed class GetUserPreview : MU3.Client.INetQuery {
    public CaptureFakeRequest request_ = new CaptureFakeRequest();
    public CaptureFakePreviewResponse response_ = new CaptureFakePreviewResponse();
    public bool setResponse(string value) { return true; }
}
public sealed class CaptureFakeWrongPreview { public int setResponse(string value) { return 1; } }
public static class CaptureFakeAgent { public static string getUserAgent(MU3.Client.INetQuery query) { return "not-invoked"; } }
public static class CaptureFakeWrongAgent { public static string getUserAgent(object query) { return "not-invoked"; } }
public sealed class CaptureFakeMachineInfo {
    public string boardId = "ANONYMOUS-BOARD";
    public int count = 7;
    public int flags = 12;
    public string version = "Anonymous OS";
    public string machineName = "anonymous-machine";
    public string userName = "anonymous-user";
    public string unrelated = "must-not-be-captured";
}
public sealed class CaptureFakeUserAll { public CaptureFakeMachineInfo clientSystemInfo = new CaptureFakeMachineInfo(); }
public sealed class CaptureFakeUpsertRequest { public CaptureFakeUserAll upsertUserAll = new CaptureFakeUserAll(); public long userId = 123456; }
public sealed class CaptureFakeQuery { public CaptureFakeUpsertRequest request_ = new CaptureFakeUpsertRequest(); }
public sealed class CaptureFakePacket { public CaptureFakeQuery query_ = new CaptureFakeQuery(); }
public sealed class CaptureFakeSetting {
    public int count = 8; public bool dirty;
    public int getSerialCount() { return count; }
    public bool getDirty() { return dirty; }
}
public sealed class CaptureFakeNativeState {
    public System.IntPtr Pointer { get; set; }
    public bool IsDone { get; set; }
    public bool IsSucceeded { get; set; }
}
public static class CaptureFakeNativeBackup {
    public static object LastSaveState { get; set; }
    public static bool IsBusy { get; set; }
}
'@
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$fixtureRoot = Join-Path $OutputDirectory ('plugin-fixture-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$checks = New-Object 'System.Collections.Generic.List[string]'
function Assert-Capture([bool]$Condition, [string]$Name) {
    if (!$Condition) {
        [ordered]@{ passedChecks = $checks.Count; failedCheck = $Name; checks = $checks.ToArray() } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'plugin-failure.json') -Encoding UTF8
        throw "Capture plugin check failed: $Name"
    }
    $checks.Add($Name)
}
$ini = Join-Path $fixtureRoot 'segatools.ini'
$iniText = "[DNS]`r`ndefault=server-a.invalid ; comment`r`nAimeDB=aime-a.invalid`r`nreplaceHost=1`r`n[netenv]`r`nenable=0`r`n[keychip]`r`nid=A123-45678901234`r`nsubnet=192.168.45.0`r`n[aime]`r`naimePath=private-path.txt`r`n[extra]`r`nsecret=must-not-be-captured`r`n"
[IO.File]::WriteAllText($ini, $iniText, (New-Object Text.UTF8Encoding($false)))
$snapshot = $methods['ReadMachineSnapshot'].Invoke($null, @($ini.ToString()))
$parsed = $snapshot | ConvertFrom-Json
Assert-Capture ($parsed.dns.default -eq 'server-a.invalid' -and $parsed.dns.replaceHost -eq '1' -and $parsed.netenv.enable -eq '0') 'case-insensitive startup whitelist and comments'
Assert-Capture (($parsed.PSObject.Properties.Name -join ',') -eq 'dns,netenv,keychip' -and $snapshot -notmatch 'secret|aimePath|private-path') 'only six machine fields, no unrelated configuration'
[IO.File]::WriteAllText($ini, "; 中文注释`r`n" + $iniText, [Text.Encoding]::GetEncoding(936))
Assert-Capture ($methods['ReadMachineSnapshot'].Invoke($null, @($ini.ToString())) -eq $snapshot) 'legacy GBK configuration'
[IO.File]::WriteAllText($ini, $iniText, [Text.Encoding]::Unicode)
Assert-Capture ($methods['ReadMachineSnapshot'].Invoke($null, @($ini.ToString())) -eq $snapshot) 'UTF-16 configuration'
$fields['root'].SetValue($null, $fixtureRoot.ToString())
$fields['machineSnapshot'].SetValue($null, $snapshot.ToString())
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'capture.enabled'), '1')
$login = New-Object CaptureFakeLogin
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
$identityText = $fields['loginIdentity'].GetValue($null)
$identity = $identityText | ConvertFrom-Json
Assert-Capture ($identity.version -eq 1 -and $identity.userId -eq 42 -and $identity.accessCode -eq $login.request_.accessCode -and $identity.clientId -eq $login.request_.clientId) 'accepted login records actual reader card and user'
Assert-Capture ($identityText -notmatch 'unrelated|must-not-be-captured|nonce|placeId') 'login ownership omits unrelated fields'
$dir = Join-Path $fixtureRoot 'owned-session'
New-Item -ItemType Directory -Path $dir | Out-Null
$methods['WriteIdentity'].Invoke($null, @($dir.ToString(),'43')) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath (Join-Path $dir 'identity.json'))) 'different read user cannot inherit last card'
$methods['WriteIdentity'].Invoke($null, @($dir.ToString(),'42')) | Out-Null
Assert-Capture ([IO.File]::ReadAllText((Join-Path $dir 'identity.json')) -eq $identityText) 'matching read writes atomic ownership sidecar'
[IO.File]::WriteAllText($ini, '[dns]' + "`n" + 'default=changed.invalid')
Assert-Capture (($fields['loginIdentity'].GetValue($null) | ConvertFrom-Json).machine.dns.default -eq 'server-a.invalid') 'later INI edits do not change captured startup source'
$login.response_.returnCode = 2
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject,$true)) | Out-Null
Assert-Capture ($null -eq $fields['loginIdentity'].GetValue($null) -and $fields['loginPlayer'].GetValue($null) -eq '') 'parsed but rejected login clears previous ownership'
$login.response_.returnCode = 100
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject,$true)) | Out-Null
Assert-Capture ($null -ne $fields['loginIdentity'].GetValue($null)) 'game accepted return code 100'
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject,$false)) | Out-Null
Assert-Capture ($null -eq $fields['loginIdentity'].GetValue($null)) 'failed response parsing clears ownership'
$login.request_.accessCode = 'invalid'
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject,$true)) | Out-Null
Assert-Capture ($null -eq $fields['loginIdentity'].GetValue($null)) 'invalid actual reader code cannot create identity'
$login.request_.accessCode = '10000000000000000001'
$login.request_.userId = 0
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject,$true)) | Out-Null
Assert-Capture ($null -eq $fields['loginIdentity'].GetValue($null)) 'guest user cannot create identity'
$names = $fields['Names'].GetValue($null)
Assert-Capture ($names -contains 'GetUserRecentRating' -and $names -contains 'GetUserRatinglog') 'optional rating reads are observable without removing six core APIs'
Assert-Capture (($names[0..5] -join ',') -eq 'GetUserData,GetUserMusic,GetUserCard,GetUserCharacter,GetUserItem,GetUserOption' -and $names -notcontains 'GetUserPreview') 'Preview diagnostics preserve ordinary six core APIs and sequence'
Assert-Capture ($null -ne $methods['PreviewResponseMethod'].Invoke($null, @([GetUserPreview])) -and $null -eq $methods['PreviewResponseMethod'].Invoke($null, @([CaptureFakeWrongPreview]))) 'optional Preview response hook requires the exact bool parse signature'
Assert-Capture ($null -ne $methods['PreviewAgentMethod'].Invoke($null, @([CaptureFakeAgent])) -and $null -eq $methods['PreviewAgentMethod'].Invoke($null, @([CaptureFakeWrongAgent]))) 'optional send-path agent hook checks static string INetQuery signature'
$preview = New-Object GetUserPreview
Assert-Capture ($methods['PreviewPlayer'].Invoke($null, @($preview.request_, $preview.response_)) -eq '42') 'Preview diagnostics require matching actual parsed player IDs and state types'
$preview.response_.userId = [long]43
Assert-Capture ($null -eq $methods['PreviewPlayer'].Invoke($null, @($preview.request_, $preview.response_))) 'foreign Preview player identity is not recorded'
$preview.response_.userId = '42'
Assert-Capture ($null -eq $methods['PreviewPlayer'].Invoke($null, @($preview.request_, $preview.response_))) 'Preview string identity is not silently converted'
$preview.response_.userId = [long]42; $preview.response_.isLogin = $true; $preview.response_.banStatus = [int]1
Assert-Capture ($methods['PreviewPlayer'].Invoke($null, @($preview.request_, $preview.response_)) -eq '42') 'parsed login and ban state are retained as evidence rather than claimed as successful login'
$preview.response_.isWarningConfirmed = 'true'
Assert-Capture ($null -eq $methods['PreviewPlayer'].Invoke($null, @($preview.request_, $preview.response_))) 'invalid Preview state field types are not recorded'
$preview.response_.isWarningConfirmed = $true
$connectionType = $type.GetNestedType('Connection', [Reflection.BindingFlags]::NonPublic)
$connection = [Activator]::CreateInstance($connectionType, $true)
$connectionType.GetField('BaseUrl').SetValue($connection, 'http://preview.invalid/game/')
$connectionType.GetField('Encryption').SetValue($connection, [int]0)
$previewConnections = [Collections.IDictionary]$fields['PreviewConnections'].GetValue($null)
$previewConnections.Add($preview.PSObject.BaseObject, $connection)
$fields['previewHooks'].SetValue($null, $false)
$methods['PreviewUserAgent'].Invoke($null, @($preview.PSObject.BaseObject, 'ANONYMOUS-SEND-AGENT')) | Out-Null
Assert-Capture ($null -eq $connectionType.GetField('Agent').GetValue($connection) -and !$methods['IsCaptureReadName'].Invoke($null, @('GetUserPreview'))) 'unavailable optional Preview hook is inert and does not join normal capture names'
$fields['previewHooks'].SetValue($null, $true)
$methods['PreviewUserAgent'].Invoke($null, @((New-Object GetUserPreview).PSObject.BaseObject, 'ANONYMOUS-WRONG-AGENT')) | Out-Null
Assert-Capture ($null -eq $connectionType.GetField('Agent').GetValue($connection) -and $previewConnections.Count -eq 1) 'only the exact already mapped Preview query can supply a send-path agent'
$methods['PreviewUserAgent'].Invoke($null, @($preview.PSObject.BaseObject, 'ANONYMOUS-SEND-AGENT')) | Out-Null
Assert-Capture ($connectionType.GetField('Agent').GetValue($connection) -eq 'ANONYMOUS-SEND-AGENT') 'Preview observes the send-path agent return value without recalculating or replacing it'
$login.request_.userId = [long]42; $login.response_.returnCode = [int]1
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject,$true)) | Out-Null
$priorSession = $fields['session'].GetValue($null); $priorSequence = $fields['sequence'].GetValue($null); $priorPlayer = $fields['player'].GetValue($null); $priorStatus = $fields['status'].GetValue($null)
$priorIdentity = $fields['loginIdentity'].GetValue($null)
$requestJson = '{"userId":42,"anonymousOriginal":true}'
$responseJson = '{ "userId":42, "isLogin":true, "banStatus":1, "isWarningConfirmed":true, "anonymousOriginal":"keep-spacing" }'
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',$requestJson,$responseJson,$null)) | Out-Null
$connectionType.GetField('Agent').SetValue($connection, $null)
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',$requestJson,$responseJson,$connection)) | Out-Null
$connectionType.GetField('Agent').SetValue($connection, 'ANONYMOUS-SEND-AGENT')
$previewDirectory = Join-Path $fixtureRoot 'preview-observations'
Assert-Capture (!(Test-Path -LiteralPath $previewDirectory)) 'Preview without an observed connection or send-path agent cannot be recorded'
$fields['previewHooks'].SetValue($null, $false)
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',$requestJson,$responseJson,$connection)) | Out-Null
$methods['ReadPreviewResponse'].Invoke($null, @($preview.PSObject.BaseObject,$responseJson,$true)) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath $previewDirectory)) 'partially unavailable optional hooks cannot write observations or invoke Unity JSON'
$fields['previewHooks'].SetValue($null, $true)
$methods['WritePreviewObservation'].Invoke($null, @($false,'42',$requestJson,$responseJson,$connection)) | Out-Null
$methods['ReadPreviewResponse'].Invoke($null, @($preview.PSObject.BaseObject,$responseJson,$false)) | Out-Null
$previewDirectory = Join-Path $fixtureRoot 'preview-observations'
Assert-Capture (!(Test-Path -LiteralPath $previewDirectory)) 'failed Preview parsing produces no diagnostic observation'
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',$requestJson,$responseJson,$connection)) | Out-Null
$observationFile = @(Get-ChildItem -LiteralPath $previewDirectory -Filter '*.json')[0]
$observationText = [IO.File]::ReadAllText($observationFile.FullName); $observation = $observationText | ConvertFrom-Json
Assert-Capture ($observationFile.Name -match '^[a-f0-9]{32}\.json$' -and $observation.api -eq 'GetUserPreviewApi' -and $observation.version -eq 1) 'Preview observation uses a random anonymous filename and fixed version API metadata'
Assert-Capture ($observationText.Contains('"request":' + $requestJson) -and $observationText.Contains('"response":' + $responseJson)) 'Preview preserves original request JSON and response spacing without reserialization'
Assert-Capture ($observation.connection.userAgent -eq 'ANONYMOUS-SEND-AGENT' -and $observation.machine.dns.default -eq 'server-a.invalid') 'Preview records its observed connection and startup machine snapshot locally only'
Assert-Capture (!(Test-Path -LiteralPath (Join-Path $fixtureRoot 'captures')) -and !(Test-Path -LiteralPath (Join-Path $fixtureRoot 'archives')) -and !(Test-Path -LiteralPath (Join-Path $previewDirectory 'identity.json'))) 'Preview never creates ordinary save captures summaries or player ownership'
Assert-Capture ($fields['session'].GetValue($null) -eq $priorSession -and $fields['sequence'].GetValue($null) -eq $priorSequence -and $fields['player'].GetValue($null) -eq $priorPlayer -and $fields['status'].GetValue($null) -eq $priorStatus -and $fields['loginIdentity'].GetValue($null) -eq $priorIdentity) 'Preview does not reset the normal session player sequence ownership or core capture status'
$fields['previewSequence'].SetValue($null, [int]128)
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',$requestJson,$responseJson,$connection)) | Out-Null
Assert-Capture (@(Get-ChildItem -LiteralPath $previewDirectory -Filter '*.json').Count -eq 1) 'Preview observations stop at the bounded per-run record limit'
$fields['previewSequence'].SetValue($null, [int]0)
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',('x' * (1024 * 1024 + 1)),$responseJson,$connection)) | Out-Null
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',$requestJson,('x' * (8 * 1024 * 1024 + 1)),$connection)) | Out-Null
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',(([string][char]0x754c) * 350000),$responseJson,$connection)) | Out-Null
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',$requestJson,(([string][char]0x754c) * 3000000),$connection)) | Out-Null
Assert-Capture (@(Get-ChildItem -LiteralPath $previewDirectory -Filter '*.json').Count -eq 1) 'oversized Preview request or response never enters the diagnostic archive'
Remove-Item -LiteralPath (Join-Path $fixtureRoot 'capture.enabled')
$methods['WritePreviewObservation'].Invoke($null, @($true,'42',$requestJson,$responseJson,$connection)) | Out-Null
Assert-Capture (@(Get-ChildItem -LiteralPath $previewDirectory -Filter '*.json').Count -eq 1) 'disabled capture cannot record Preview diagnostics'
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'capture.enabled'), '1')
# Independent Upsert observations use original strings passed to postfixes.
# Fake getRequest/setResponse deliberately throw if the observer invokes them.
$upsertDirectory = Join-Path $fixtureRoot 'upsert-observations'
$upsertObservations = [Collections.IDictionary]$fields['UpsertObservations'].GetValue($null)
$upsertObservationType = $type.GetNestedType('UpsertObservation', [Reflection.BindingFlags]::NonPublic)
$serializedUpsert = "{`r`n `"nonce_`":8,`"userId`":42,`"regionId`":1,`"placeId`":3,`"accessCode`":`"10000000000000000001`",`"clientId`":`"A1234567890`",`"upsertUserAll`":{`"userNewRatingBaseBestList`":[null,{}, {`"musicId`":0,`"score`":0}],`"anonymousText`":`"保留 \\t 原始格式`"}}"
$serializedUpsertResponse = '{ "returnCode" : 1, "anonymousOriginal" : "preserve-spacing" }'
function Start-AnonymousUpsert {
    $script:upsert = New-Object MU3.Client.UpsertUserAll
    $script:upsertConnection = [Activator]::CreateInstance($connectionType, $true)
    $connectionType.GetField('BaseUrl').SetValue($script:upsertConnection, 'http://upsert.invalid/game/')
    $connectionType.GetField('Encryption').SetValue($script:upsertConnection, [int]0)
    $methods['RememberUpsertQuery'].Invoke($null, @($script:upsert.PSObject.BaseObject, $script:upsertConnection)) | Out-Null
}
function Observe-AnonymousUpsert {
    $methods['ReadUpsertRequest'].Invoke($null, @($script:upsert.PSObject.BaseObject, $serializedUpsert)) | Out-Null
    $methods['UpsertUserAgent'].Invoke($null, @($script:upsert.PSObject.BaseObject, 'ANONYMOUS-UPSERT-SEND-AGENT')) | Out-Null
}
function Complete-AnonymousUpsert([bool]$Parsed = $true, [string]$Response = $serializedUpsertResponse) {
    $methods['ReadUpsertResponse'].Invoke($null, @($script:upsert.PSObject.BaseObject, $Response, $Parsed)) | Out-Null
}
function Count-UpsertFiles {
    if (!(Test-Path -LiteralPath $upsertDirectory)) { return 0 }
    return @(Get-ChildItem -LiteralPath $upsertDirectory -Filter '*.json').Count
}
Assert-Capture ($null -ne $methods['UpsertRequestMethod'].Invoke($null, @([MU3.Client.UpsertUserAll])) -and $null -eq $methods['UpsertRequestMethod'].Invoke($null, @([CaptureFakeWrongUpsert])) -and $null -eq $methods['UpsertRequestMethod'].Invoke($null, @([CaptureFakeStaticUpsert]))) 'optional Upsert serialization hook requires an instance zero-argument string signature'
$fields['upsertHooks'].SetValue($null, $true)
Assert-Capture (!$methods['IsCaptureReadName'].Invoke($null, @('UpsertUserAll')) -and $names -notcontains 'UpsertUserAll') 'Upsert diagnostics never enter core or optional read API names'
$login.request_.userId = [long]42; $login.response_.returnCode = [int]2
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
Start-AnonymousUpsert; Observe-AnonymousUpsert; Complete-AnonymousUpsert
Assert-Capture ($upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq 0) 'rejected or missing login cannot establish Upsert ownership'
foreach ($specialLogin in @([int]100, '100', '1')) {
    $login.response_.returnCode = $specialLogin
    $methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
    Start-AnonymousUpsert; Observe-AnonymousUpsert; Complete-AnonymousUpsert
    Assert-Capture ($null -ne $fields['loginIdentity'].GetValue($null) -and !$fields['loginSaveAccepted'].GetValue($null) -and $upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq 0) ('core read ownership is preserved while non-normal or coerced login is excluded from Upsert: ' + $specialLogin.GetType().Name + '-' + $specialLogin)
}
$login.response_.returnCode = [int]1
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
foreach ($change in @('user','card','client')) {
    Start-AnonymousUpsert
    if ($change -eq 'user') { $upsert.request_.userId = [long]43 }
    if ($change -eq 'card') { $upsert.request_.accessCode = '10000000000000000002' }
    if ($change -eq 'client') { $upsert.request_.clientId = 'A1234567891' }
    Observe-AnonymousUpsert; Complete-AnonymousUpsert
}
Assert-Capture ((Count-UpsertFiles) -eq 0) 'foreign actual user card and client cannot inherit accepted login identity'
Start-AnonymousUpsert; Observe-AnonymousUpsert
$otherQuery = New-Object MU3.Client.UpsertUserAll
$methods['ReadUpsertResponse'].Invoke($null, @($otherQuery.PSObject.BaseObject, $serializedUpsertResponse, $true)) | Out-Null
Assert-Capture ($upsertObservations.Count -eq 1 -and (Count-UpsertFiles) -eq 0) 'query equality overrides cannot pair a different response object'
$coreBeforeUpsert = @{}
foreach ($name in @('session','sequence','player','status','loginIdentity','previewSequence','pendingMachine')) { $coreBeforeUpsert[$name] = $fields[$name].GetValue($null) }
$previewPendingBefore = $previewConnections.Count; $ordinaryPendingBefore = ([Collections.IDictionary]$fields['Connections'].GetValue($null)).Count
$machineSentinel = Join-Path $fixtureRoot 'machine-context.json'
[IO.File]::WriteAllText($machineSentinel, 'anonymous-existing-machine-context')
Complete-AnonymousUpsert
$upsertFile = @(Get-ChildItem -LiteralPath $upsertDirectory -Filter '*.json')[0]
$upsertRecord = [IO.File]::ReadAllText($upsertFile.FullName) | ConvertFrom-Json
Assert-Capture ($upsertFile.Name -match '^[a-f0-9]{32}\.json$' -and $upsertRecord.version -eq 1 -and $upsertRecord.api -eq 'UpsertUserAllApi' -and $upsertRecord.returnCode -eq 1) 'accepted native Upsert uses fixed metadata and an anonymous random filename'
Assert-Capture ($upsertRecord.serializedRequest -ceq $serializedUpsert -and $upsertRecord.serializedResponse -ceq $serializedUpsertResponse) 'Upsert preserves actual serialized strings including null empty and zero slots without invoking serializer'
Assert-Capture ($upsertRecord.sessionId -eq $fields['session'].GetValue($null)) 'successful Upsert records the exact immutable login capture session'
Assert-Capture ($upsertRecord.identity.userId -eq 42 -and $upsertRecord.identity.accessCode -eq $login.request_.accessCode -and $upsertRecord.identity.clientId -eq $login.request_.clientId -and $upsertRecord.machine.dns.default -eq 'server-a.invalid' -and $upsertRecord.connection.userAgent -eq 'ANONYMOUS-UPSERT-SEND-AGENT') 'Upsert binds accepted actual reader identity startup machine and observed send-path metadata locally'
$coreStable = $true
foreach ($name in $coreBeforeUpsert.Keys) { if ($fields[$name].GetValue($null) -ne $coreBeforeUpsert[$name]) { $coreStable = $false } }
Assert-Capture ($coreStable -and $previewConnections.Count -eq $previewPendingBefore -and ([Collections.IDictionary]$fields['Connections'].GetValue($null)).Count -eq $ordinaryPendingBefore -and [IO.File]::ReadAllText($machineSentinel) -eq 'anonymous-existing-machine-context' -and !(Test-Path -LiteralPath (Join-Path $fixtureRoot 'captures')) -and !(Test-Path -LiteralPath (Join-Path $fixtureRoot 'archives'))) 'Upsert leaves ordinary capture ownership status Preview dictionaries and machine cache unchanged'
Remove-Item -LiteralPath $machineSentinel
Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq 1 -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) 'the exact response consumes its pending request once and releases the memory budget'
# Actual factory capture also remains passive and does not calculate a UA.
$upsert = New-Object MU3.Client.UpsertUserAll
$methods['BeginPacket'].Invoke($null, @($upsert.PSObject.BaseObject)) | Out-Null
$connectArguments = [object[]]@([uint32]0, [uint16]0, 'anonymous', 'upsert.invalid', '/game/UpsertUserAllApi', [int]0, $false, [int]0)
$methods['Connect'].Invoke($null, [object[]]@(,$connectArguments)) | Out-Null
$methods['EndPacket'].Invoke($null, @()) | Out-Null
Assert-Capture ($upsertObservations.Count -eq 1 -and $null -eq $upsertObservationType.GetField('Agent').GetValue($upsertObservations[$upsert.PSObject.BaseObject])) 'Upsert factory observes its connection without invoking or inventing an agent'
Observe-AnonymousUpsert; Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq 2) 'matching actual factory serialization agent and response observations publish together'
$upsert = New-Object MU3.Client.UpsertUserAll
Observe-AnonymousUpsert
$upsertConnection = [Activator]::CreateInstance($connectionType, $true)
$connectionType.GetField('BaseUrl').SetValue($upsertConnection, 'http://late-connection.invalid/game/')
$connectionType.GetField('Encryption').SetValue($upsertConnection, [int]0)
$methods['RememberUpsertQuery'].Invoke($null, @($upsert.PSObject.BaseObject, $upsertConnection)) | Out-Null
Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq 3) 'connection arriving after original serialization and agent preserves exact query pairing'
foreach ($missing in @('connection','agent','request')) {
    $upsert = New-Object MU3.Client.UpsertUserAll
    if ($missing -ne 'connection') { $methods['RememberUpsertQuery'].Invoke($null, @($upsert.PSObject.BaseObject, $upsertConnection)) | Out-Null }
    if ($missing -ne 'request') { $methods['ReadUpsertRequest'].Invoke($null, @($upsert.PSObject.BaseObject, $serializedUpsert)) | Out-Null }
    if ($missing -ne 'agent') { $methods['UpsertUserAgent'].Invoke($null, @($upsert.PSObject.BaseObject, 'ANONYMOUS-UPSERT-SEND-AGENT')) | Out-Null }
    Complete-AnonymousUpsert
    if ($supportsUpsertProgress) { Assert-Capture ([IO.File]::ReadAllText((Join-Path $fixtureRoot 'upsert-capture-status.txt')).Trim() -eq 'incomplete') ('missing send-path context has a separate anonymous progress status: ' + $missing) }
}
Assert-Capture ((Count-UpsertFiles) -eq 3) 'missing actual connection serialization or send agent has no fallback and cannot publish'
$nativeRejectionStatus = ''
foreach ($rejection in @('parse','returnCode','codeType','requestObject','generation','machine','age')) {
    Start-AnonymousUpsert; Observe-AnonymousUpsert
    if ($rejection -eq 'returnCode') { $upsert.response_.returnCode = [int]2 }
    if ($rejection -eq 'codeType') { $upsert.response_.returnCode = '1' }
    if ($rejection -eq 'requestObject') { $upsert.request_ = New-Object CaptureFakeRequest }
    if ($rejection -eq 'generation') { $fields['loginGeneration'].SetValue($null, [Guid]::NewGuid().ToString('N')) }
    if ($rejection -eq 'machine') { $fields['machineSnapshot'].SetValue($null, '{}') }
    if ($rejection -eq 'age') { $upsertObservationType.GetField('Started').SetValue($upsertObservations[$upsert.PSObject.BaseObject], [DateTime]::UtcNow.AddMinutes(-3)) }
    Complete-AnonymousUpsert ($rejection -ne 'parse')
    if ($rejection -eq 'codeType') { $nativeRejectionStatus = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'upsert-capture-status.txt')).Trim() }
    $fields['machineSnapshot'].SetValue($null, $snapshot.ToString())
}
Assert-Capture ((Count-UpsertFiles) -eq 3 -and $upsertObservations.Count -eq 0) 'failed rejected coerced replaced stale or cross-generation response cannot publish'
foreach ($lateChange in @('user','card','client')) {
    Start-AnonymousUpsert; Observe-AnonymousUpsert
    if ($lateChange -eq 'user') { $upsert.request_.userId = [long]43 }
    if ($lateChange -eq 'card') { $upsert.request_.accessCode = '10000000000000000002' }
    if ($lateChange -eq 'client') { $upsert.request_.clientId = 'A1234567891' }
    Complete-AnonymousUpsert
}
Assert-Capture ((Count-UpsertFiles) -eq 3 -and $upsertObservations.Count -eq 0) 'player card and client mutations after serialization fail the publication ownership check'
Assert-Capture ($nativeRejectionStatus -eq 'not-confirmed') 'native rejection status remains a separate fixed anonymous diagnostic'
Start-AnonymousUpsert; Observe-AnonymousUpsert
$oldGeneration = $fields['loginGeneration'].GetValue($null)
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
Complete-AnonymousUpsert
Assert-Capture ($upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq 3 -and $fields['loginGeneration'].GetValue($null) -ne $oldGeneration -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) 'every new login clears pending raw requests without resetting the per-run Upsert count'
Start-AnonymousUpsert; Observe-AnonymousUpsert
$login.response_.returnCode = [int]2
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
Complete-AnonymousUpsert
Assert-Capture ($upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq 3 -and $fields['loginCard'].GetValue($null) -eq '' -and $fields['loginClient'].GetValue($null) -eq '') 'rejected login clears prior card client and pending Upsert generation'
$login.response_.returnCode = [int]1
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
$fields['upsertHooks'].SetValue($null, $false)
Start-AnonymousUpsert; Observe-AnonymousUpsert; Complete-AnonymousUpsert
Assert-Capture ($upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq 3) 'unavailable optional Upsert hooks remain inert without invoking fake game methods'
$fields['upsertHooks'].SetValue($null, $true)
Start-AnonymousUpsert; Observe-AnonymousUpsert
Remove-Item -LiteralPath (Join-Path $fixtureRoot 'capture.enabled')
Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq 3 -and $upsertObservations.Count -eq 0) 'disabled capture cannot publish an already pending Upsert request'
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'capture.enabled'), '1')
$fields['upsertSequence'].SetValue($null, [int]32)
Start-AnonymousUpsert; Observe-AnonymousUpsert; Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq 3 -and $upsertObservations.Count -eq 0) 'independent Upsert run limit is not borrowed from Preview or reset by login'
$fields['upsertSequence'].SetValue($null, [int]3)
foreach ($oversizedRequest in @(('x' * (8 * 1024 * 1024 + 1)), (([string][char]0x754c) * 2800000))) {
    Start-AnonymousUpsert
    $methods['ReadUpsertRequest'].Invoke($null, @($upsert.PSObject.BaseObject, $oversizedRequest)) | Out-Null
    $methods['UpsertUserAgent'].Invoke($null, @($upsert.PSObject.BaseObject, 'ANONYMOUS-UPSERT-SEND-AGENT')) | Out-Null
    Complete-AnonymousUpsert
}
foreach ($oversizedResponse in @(('x' * (1024 * 1024 + 1)), (([string][char]0x754c) * 350000))) {
    Start-AnonymousUpsert; Observe-AnonymousUpsert; Complete-AnonymousUpsert $true $oversizedResponse
}
Assert-Capture ((Count-UpsertFiles) -eq 3 -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) 'UTF-8 byte bounds reject oversized ASCII and multibyte request and response strings'
for ($i = 0; $i -lt 65; $i++) { Start-AnonymousUpsert }
Assert-Capture ($upsertObservations.Count -eq 64) 'Upsert query mapping is independently bounded by exact object references'
$expiredQuery = @($upsertObservations.Keys)[0]
$upsertObservationType.GetField('Started').SetValue($upsertObservations[$expiredQuery], [DateTime]::UtcNow.AddMinutes(-3))
Start-AnonymousUpsert
Assert-Capture ($upsertObservations.Count -eq 64 -and !$upsertObservations.ContainsKey($expiredQuery)) 'expired Upsert observations release bounded mappings before admitting new queries'
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
$budgetPrefix = $serializedUpsert.Substring(0,$serializedUpsert.LastIndexOf('}')) + ',"padding":"'
$budgetSuffix = '"}'
$budgetRequest = $budgetPrefix + ('x' * (8*1024*1024-[Text.Encoding]::UTF8.GetByteCount($budgetPrefix+$budgetSuffix))) + $budgetSuffix
for ($i = 0; $i -lt 3; $i++) {
    Start-AnonymousUpsert
    $methods['ReadUpsertRequest'].Invoke($null, @($upsert.PSObject.BaseObject, $budgetRequest)) | Out-Null
}
Assert-Capture ($upsertObservations.Count -eq 2 -and $fields['upsertRequestBytes'].GetValue($null) -eq (16 * 1024 * 1024)) 'all pending serialized Upserts share a bounded sixteen MiB memory budget'
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
# Compile the native request shape in a separate anonymous assembly. The
# earlier class-request fixtures remain unchanged and still run all guards.
# Unlike an object field containing a boxed value, this actual struct field
# yields a fresh box on every reflection read, just as the native game does.
$nativeFixturePath = Join-Path $fixtureRoot 'native-value-request-fixture.dll'
Add-Type -OutputAssembly $nativeFixturePath -IgnoreWarnings -TypeDefinition @'
namespace MU3.Client {
    public interface INetQuery {}
    public class UserAll {
        public object[] userData = new object[] { new object() };
        public object[] userMusicDetailList = new object[0];
        public string isNewMusicDetailList = "";
        public static int serializerCalls;
        public string serialize() { serializerCalls++; throw new System.InvalidOperationException("Observer must never serialize payload"); }
    }
    public struct UpsertUserAllRequest {
        public int nonce_;
        public long userId;
        public int regionId;
        public uint placeId;
        public string clientId;
        public string accessCode;
        public UserAll upsertUserAll;
        public string serialize() { nonce_++; UserAll.serializerCalls++; throw new System.InvalidOperationException("Observer must never serialize request"); }
    }
    public struct UpsertUserAllResponse { public int returnCode; }
    public class UpsertUserAll : INetQuery {
        public UpsertUserAllRequest request_;
        public UpsertUserAllResponse response_;
        public UpsertUserAll() {
            request_ = new UpsertUserAllRequest { nonce_ = 7, userId = 42, regionId = 1, placeId = 3,
                clientId = "A1234567890", accessCode = "10000000000000000001", upsertUserAll = new UserAll() };
            response_ = new UpsertUserAllResponse { returnCode = 1 };
        }
        public string getRequest() { throw new System.InvalidOperationException("Observer must never invoke native-shape getRequest"); }
        public bool setResponse(string value) { throw new System.InvalidOperationException("Observer must never invoke native-shape setResponse"); }
        public override bool Equals(object value) { return value is UpsertUserAll; }
        public override int GetHashCode() { return 1; }
    }
    public class NetHttpClient {
        private int state_ = 3;
        private int errorCode_ = 0;
        private int httpStatusCode_ = 200;
        private int responseLength_ = 0;
        private byte[] response_ = new byte[0];
        public static int methodCalls;
        public static NetHttpClient Create(uint ipv4, ushort port, string host, string hostPort, string path, int encryption, bool tls, int method) { methodCalls++; throw new System.InvalidOperationException("Observer must never create client"); }
        public bool request(byte[] bytes, string agent, bool compress) { methodCalls++; throw new System.InvalidOperationException("Observer must never send"); }
        public bool request() { methodCalls++; throw new System.InvalidOperationException("Observer must never retry"); }
        private void onCompleted() { methodCalls++; throw new System.InvalidOperationException("Observer must never complete transport"); }
        public void getResponse(out int length, out byte[] bytes) { methodCalls++; throw new System.InvalidOperationException("Observer must never call response getter"); }
        public override bool Equals(object other) { return other is NetHttpClient; }
        public override int GetHashCode() { return 1; }
    }
    public class Packet {
        protected INetQuery query_;
        public Packet(UpsertUserAll query) { query_ = query; }
        protected bool reset() { NetHttpClient.methodCalls++; throw new System.InvalidOperationException("Observer must never reset packet"); }
    }
    public static class AnonymousWeakProbe {
        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        public static System.WeakReference MakeUnownedWeak() { return new System.WeakReference(new object()); }
        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        public static System.WeakReference MakeHttpWeak() { return new System.WeakReference(new NetHttpClient()); }
    }
}
'@
$nativeFixture = [Reflection.Assembly]::LoadFrom($nativeFixturePath)
$nativeQueryType = $nativeFixture.GetType('MU3.Client.UpsertUserAll', $true)
$nativeRequestField = $nativeQueryType.GetField('request_')
$nativePayloadType = $nativeFixture.GetType('MU3.Client.UserAll', $true)
function Start-NativeUpsert {
    $script:upsert = [Activator]::CreateInstance($nativeQueryType)
    $script:upsertConnection = [Activator]::CreateInstance($connectionType, $true)
    $connectionType.GetField('BaseUrl').SetValue($script:upsertConnection, 'http://native-upsert.invalid/game/')
    $connectionType.GetField('Encryption').SetValue($script:upsertConnection, [int]0)
    $methods['RememberUpsertQuery'].Invoke($null, @($script:upsert.PSObject.BaseObject, $script:upsertConnection)) | Out-Null
}
function Set-NativeUpsertField([string]$Name, [object]$Value) {
    $boxedRequest = $nativeRequestField.GetValue($script:upsert.PSObject.BaseObject)
    $boxedRequest.GetType().GetField($Name).SetValue($boxedRequest, $Value)
    $nativeRequestField.SetValue($script:upsert.PSObject.BaseObject, $boxedRequest)
}
$nativeStartCount = Count-UpsertFiles
Start-NativeUpsert
$firstBox = $nativeRequestField.GetValue($upsert.PSObject.BaseObject)
$secondBox = $nativeRequestField.GetValue($upsert.PSObject.BaseObject)
Assert-Capture ($firstBox.GetType().IsValueType -and $firstBox.GetType().FullName -eq 'MU3.Client.UpsertUserAllRequest' -and ![object]::ReferenceEquals($firstBox, $secondBox) -and [object]::ReferenceEquals($firstBox.upsertUserAll, $secondBox.upsertUserAll) -and $methods['UpsertOwnerMatches'].Invoke($null, @($secondBox, $upsertObservations[$upsert.PSObject.BaseObject]))) 'actual native struct field reboxes while the exact class payload and owner stay bound'
Assert-Capture ([IO.File]::ReadAllText((Join-Path $fixtureRoot 'upsert-capture-status.txt')).Trim() -eq 'query-observed') 'matched native query exposes only fixed independent query progress'
Set-NativeUpsertField 'nonce_' ([int]8)
$methods['ReadUpsertRequest'].Invoke($null, @($upsert.PSObject.BaseObject, $serializedUpsert)) | Out-Null
Assert-Capture ([IO.File]::ReadAllText((Join-Path $fixtureRoot 'upsert-capture-status.txt')).Trim() -eq 'request-observed') 'actual native serialized result advances independent request progress'
$methods['UpsertUserAgent'].Invoke($null, @($upsert.PSObject.BaseObject, 'ANONYMOUS-UPSERT-SEND-AGENT')) | Out-Null
Assert-Capture ([IO.File]::ReadAllText((Join-Path $fixtureRoot 'upsert-capture-status.txt')).Trim() -eq 'waiting-for-response') 'complete actual native send context waits for its exact response'
Set-NativeUpsertField 'nonce_' ([int]9)
Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq ($nativeStartCount + 1) -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0 -and $nativePayloadType.GetField('serializerCalls').GetValue($null) -eq 0) 'native struct nonce changes do not prevent accepted original-string observation or invoke serialization'
foreach ($nativeMutation in @('userId','accessCode','clientId','regionId','placeId','upsertUserAll','userData','isNewMusicDetailList')) {
    Start-NativeUpsert; Observe-AnonymousUpsert
    switch ($nativeMutation) {
        'userId' { Set-NativeUpsertField $nativeMutation ([long]43) }
        'accessCode' { Set-NativeUpsertField $nativeMutation '10000000000000000002' }
        'clientId' { Set-NativeUpsertField $nativeMutation 'A1234567891' }
        'regionId' { Set-NativeUpsertField $nativeMutation ([int]2) }
        'placeId' { Set-NativeUpsertField $nativeMutation ([uint32]4) }
        'upsertUserAll' { Set-NativeUpsertField $nativeMutation ([Activator]::CreateInstance($nativePayloadType)) }
        'userData' { $nativePayload = $nativeRequestField.GetValue($upsert.PSObject.BaseObject).upsertUserAll; $nativePayloadType.GetField('userData').SetValue($nativePayload, [object[]]@(New-Object object)) }
        'isNewMusicDetailList' { $nativePayload = $nativeRequestField.GetValue($upsert.PSObject.BaseObject).upsertUserAll; $nativePayloadType.GetField('isNewMusicDetailList').SetValue($nativePayload, '1') }
    }
    Complete-AnonymousUpsert
    Assert-Capture ((Count-UpsertFiles) -eq ($nativeStartCount + 1) -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) ('native struct replaced context or top-level payload is rejected: ' + $nativeMutation)
}
foreach ($nativeLogin in @([int]2, [int]100, '1', '100')) {
    $login.response_.returnCode = $nativeLogin
    $methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
    Start-NativeUpsert; Observe-AnonymousUpsert; Complete-AnonymousUpsert
    Assert-Capture ((Count-UpsertFiles) -eq ($nativeStartCount + 1) -and $upsertObservations.Count -eq 0) ('native struct cannot inherit a rejected non-normal or coerced login: ' + $nativeLogin.GetType().Name + '-' + $nativeLogin)
}
$login.response_.returnCode = [int]1
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
Start-NativeUpsert; Observe-AnonymousUpsert
$differentNativeQuery = [Activator]::CreateInstance($nativeQueryType)
$methods['ReadUpsertResponse'].Invoke($null, @($differentNativeQuery, $serializedUpsertResponse, $true)) | Out-Null
Assert-Capture ($upsertObservations.Count -eq 1 -and (Count-UpsertFiles) -eq ($nativeStartCount + 1)) 'native struct value equality does not pair another query response'
Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq ($nativeStartCount + 2) -and $upsertObservations.Count -eq 0) 'exact native query response publishes once after a foreign response is ignored'
foreach ($nativeBoundary in @('generation','machine','age','responseCode','parse','disabled','requestSize','responseSize','runLimit')) {
    Start-NativeUpsert; Observe-AnonymousUpsert
    $counterBeforeNativeBoundary = $fields['upsertSequence'].GetValue($null)
    switch ($nativeBoundary) {
        'generation' { $fields['loginGeneration'].SetValue($null, [Guid]::NewGuid().ToString('N')) }
        'machine' { $fields['machineSnapshot'].SetValue($null, '{}') }
        'age' {
            $expiredNativeTime = [DateTime]::UtcNow.AddMinutes(-3)
            $expiredNative = $upsertObservations[$upsert.PSObject.BaseObject]
            $upsertObservationType.GetField('Started').SetValue($expiredNative, $expiredNativeTime)
            $nativeLifetimeField = $upsertObservationType.GetField('Lifetime')
            if ($null -ne $nativeLifetimeField) {
                $nativeLifetime = $nativeLifetimeField.GetValue($expiredNative)
                $nativeLifetime.GetType().GetField('Started').SetValue($nativeLifetime, $expiredNativeTime)
            }
        }
        'responseCode' {
            $nativeResponseField = $nativeQueryType.GetField('response_'); $nativeResponseBox = $nativeResponseField.GetValue($upsert.PSObject.BaseObject)
            $nativeResponseBox.GetType().GetField('returnCode').SetValue($nativeResponseBox, [int]2); $nativeResponseField.SetValue($upsert.PSObject.BaseObject, $nativeResponseBox)
        }
        'disabled' { Remove-Item -LiteralPath (Join-Path $fixtureRoot 'capture.enabled') }
        'requestSize' { $methods['ReadUpsertRequest'].Invoke($null, @($upsert.PSObject.BaseObject, ('x' * (8 * 1024 * 1024 + 1)))) | Out-Null }
        'runLimit' { $fields['upsertSequence'].SetValue($null, [int]32) }
    }
    if ($nativeBoundary -eq 'responseSize') { Complete-AnonymousUpsert $true ('x' * (1024 * 1024 + 1)) }
    else { Complete-AnonymousUpsert ($nativeBoundary -ne 'parse') }
    Assert-Capture ((Count-UpsertFiles) -eq ($nativeStartCount + 2) -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) ('native struct retains independent publication boundaries: ' + $nativeBoundary)
    $fields['machineSnapshot'].SetValue($null, $snapshot.ToString())
    $fields['upsertSequence'].SetValue($null, [int]$counterBeforeNativeBoundary)
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'capture.enabled'), '1')
}
Start-NativeUpsert; Observe-AnonymousUpsert
$nativeGenerationBeforeLogin = $fields['loginGeneration'].GetValue($null)
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq ($nativeStartCount + 2) -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0 -and $fields['loginGeneration'].GetValue($null) -ne $nativeGenerationBeforeLogin) 'new normal login consumes no prior native struct request and clears its bounded raw bytes'
# Same-query lifetime must survive pruning, rejection, consumption and Login.
$nativeLifetimeType = $type.GetNestedType('UpsertLifetime', [Reflection.BindingFlags]::NonPublic)
$nativeLifetimes = $null
if ($null -ne $fields['UpsertLifetimes']) { $nativeLifetimes = [Collections.IList]$fields['UpsertLifetimes'].GetValue($null) }
function Observe-LateNativeConnection {
    $methods['BeginPacket'].Invoke($null, @($script:upsert.PSObject.BaseObject)) | Out-Null
    $methods['Connect'].Invoke($null, [object[]]@(,$connectArguments)) | Out-Null
    $methods['EndPacket'].Invoke($null, @()) | Out-Null
}
foreach ($lateOrder in @('request-agent-connect','agent-connect-request','connect-request-agent')) {
    Start-NativeUpsert; Observe-AnonymousUpsert
    $retiredCount = Count-UpsertFiles
    $nativeExpiredObservation = $upsertObservations[$upsert.PSObject.BaseObject]
    $expiredNativeTime = [DateTime]::UtcNow.AddMinutes(-3)
    $upsertObservationType.GetField('Started').SetValue($nativeExpiredObservation, $expiredNativeTime)
    $nativeExpiredLifetimeField = $upsertObservationType.GetField('Lifetime')
    if ($null -ne $nativeExpiredLifetimeField) {
        $nativeExpiredLifetime = $nativeExpiredLifetimeField.GetValue($nativeExpiredObservation)
        $nativeLifetimeType.GetField('Started').SetValue($nativeExpiredLifetime, $expiredNativeTime)
    }
    foreach ($lateStage in $lateOrder.Split('-')) {
        switch ($lateStage) {
            'request' { $methods['ReadUpsertRequest'].Invoke($null, @($upsert.PSObject.BaseObject, $serializedUpsert)) | Out-Null }
            'agent' { $methods['UpsertUserAgent'].Invoke($null, @($upsert.PSObject.BaseObject, 'ANONYMOUS-UPSERT-SEND-AGENT')) | Out-Null }
            'connect' { Observe-LateNativeConnection }
        }
    }
    Complete-AnonymousUpsert
    Assert-Capture ((Count-UpsertFiles) -eq $retiredCount -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) ('expired native query cannot receive a fresh lifetime from late stages: ' + $lateOrder)
}
Start-NativeUpsert; Observe-AnonymousUpsert
$retryObservation = $upsertObservations[$upsert.PSObject.BaseObject]
$retryStart = $upsertObservationType.GetField('Started').GetValue($retryObservation)
$retryGeneration = $upsertObservationType.GetField('Generation').GetValue($retryObservation)
Observe-AnonymousUpsert; Observe-LateNativeConnection
Assert-Capture ([object]::ReferenceEquals($retryObservation, $upsertObservations[$upsert.PSObject.BaseObject]) -and $upsertObservationType.GetField('Started').GetValue($retryObservation) -eq $retryStart -and $upsertObservationType.GetField('Generation').GetValue($retryObservation) -eq $retryGeneration) 'legitimate native retries keep the original pending query start and generation'
Complete-AnonymousUpsert
$consumedCount = Count-UpsertFiles
Observe-AnonymousUpsert; Observe-LateNativeConnection; Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq $consumedCount -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) 'consumed native query cannot be registered again by replayed send observations'
Start-NativeUpsert; Observe-AnonymousUpsert
$replacedPayload = $nativeRequestField.GetValue($upsert.PSObject.BaseObject).upsertUserAll
Set-NativeUpsertField 'upsertUserAll' ([Activator]::CreateInstance($nativePayloadType))
$methods['UpsertUserAgent'].Invoke($null, @($upsert.PSObject.BaseObject, 'ANONYMOUS-UPSERT-SEND-AGENT')) | Out-Null
Set-NativeUpsertField 'upsertUserAll' $replacedPayload
Observe-AnonymousUpsert; Observe-LateNativeConnection; Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq $consumedCount -and $upsertObservations.Count -eq 0) 'restoring a rejected native payload does not reset the same query lifetime'
Start-NativeUpsert; Observe-AnonymousUpsert
$priorLoginQuery = $upsert
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
Observe-AnonymousUpsert; Observe-LateNativeConnection; Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq $consumedCount -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) 'late old native query send observations cannot inherit the next accepted login generation'
Start-NativeUpsert; Observe-AnonymousUpsert; Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq ($consumedCount + 1) -and $upsertObservations.Count -eq 0) 'a distinct native query remains eligible after the next accepted login'
# Preserve live targets deliberately so the weak registry reaches its cap;
# diagnostic saturation must not retain game queries or reset normal state.
$methods['UpsertQueryLifetime'].Invoke($null, @($priorLoginQuery.PSObject.BaseObject)) | Out-Null
$heldNativeQueries = New-Object 'System.Collections.Generic.List[object]'
foreach ($stamp in $nativeLifetimes) {
    $target = $nativeLifetimeType.GetField('Query').GetValue($stamp).Target
    if ($null -ne $target) { $heldNativeQueries.Add($target) }
}
while ($nativeLifetimes.Count -lt 256) { Start-NativeUpsert; $heldNativeQueries.Add($upsert.PSObject.BaseObject) }
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
$fullWeakCount = Count-UpsertFiles
$ordinaryStatusBeforeWeakCap = $fields['status'].GetValue($null)
Start-NativeUpsert; Observe-AnonymousUpsert; Complete-AnonymousUpsert
Assert-Capture ($nativeLifetimes.Count -eq 256 -and $upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq $fullWeakCount -and $fields['status'].GetValue($null) -eq $ordinaryStatusBeforeWeakCap -and [IO.File]::ReadAllText((Join-Path $fixtureRoot 'upsert-capture-status.txt')).Trim() -eq 'limit-reached') 'full live weak lifetime registry stops only new diagnostics at its fixed 256-entry bound'
$weakOnly = $true
foreach ($stamp in $nativeLifetimes) {
    foreach ($lifetimeField in $nativeLifetimeType.GetFields()) {
        $lifetimeValue = $lifetimeField.GetValue($stamp)
        if ($null -ne $lifetimeValue -and !($lifetimeValue -is [WeakReference]) -and !($lifetimeValue -is [string]) -and !($lifetimeValue -is [DateTime]) -and !($lifetimeValue -is [bool])) { $weakOnly = $false }
    }
}
Assert-Capture $weakOnly 'retired lifetime markers contain only weak query references and fixed generation time flags'
$deadWeak = $nativeFixture.GetType('MU3.Client.AnonymousWeakProbe', $true).GetMethod('MakeUnownedWeak').Invoke($null, @())
[GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()
Assert-Capture (!$deadWeak.IsAlive) 'anonymous unowned weak target is actually collectible without retaining a payload'
$deadStamp = [Activator]::CreateInstance($nativeLifetimeType, $true)
$nativeLifetimeType.GetField('Query').SetValue($deadStamp, $deadWeak)
$nativeLifetimes.RemoveAt($nativeLifetimes.Count - 1); $nativeLifetimes.Add($deadStamp) | Out-Null
Start-NativeUpsert; Observe-AnonymousUpsert; Complete-AnonymousUpsert
Assert-Capture ($nativeLifetimes.Count -le 256 -and $upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq ($fullWeakCount + 1)) 'a collected weak target is pruned so a distinct native query can be observed again'
# Observe the actual plaintext transport boundaries, without invoking even the
# throwing anonymous client methods. Its private fields match native metadata.
$nativeLifetimes.Clear()
$fields['upsertSequence'].SetValue($null, [int]0)
$methods['Login'].Invoke($null, @($login.PSObject.BaseObject, $true)) | Out-Null
$transportClientType = $nativeFixture.GetType('MU3.Client.NetHttpClient', $true)
$transportPacketType = $nativeFixture.GetType('MU3.Client.Packet', $true)
$transportFieldFlags = [Reflection.BindingFlags]'NonPublic,Instance'
$transportFields = @{}
foreach ($name in @('state_','errorCode_','httpStatusCode_','responseLength_','response_')) { $transportFields[$name] = $transportClientType.GetField($name,$transportFieldFlags) }
$factoryArgs = [object[]]@([uint32]0,[uint16]80,'upsert.invalid','upsert.invalid','/game/UpsertUserAllApi',[int]0,$false,[int]0)
$transportText = '{ "nonce_":7,"userId":42,"regionId":1,"placeId":3,"clientId":"A1234567890","accessCode":"10000000000000000001","upsertUserAll":{"userNewRatingBaseBestList":[null,{}, {"musicId":0,"score":0}],"anonymousText":"保留原始格式"} }'
$transportResponse = '{ "returnCode" : 1 }'
function Bind-AnonymousTransport([object]$Client) {
    $methods['BeginPacket'].Invoke($null,@($upsert.PSObject.BaseObject)) | Out-Null
    try { $methods['CreatedUpsertClient'].Invoke($null,[object[]]@($Client,$factoryArgs)) | Out-Null }
    finally { $methods['EndPacket'].Invoke($null,@()) | Out-Null }
}
function Start-AnonymousTransport {
    Start-NativeUpsert
    $script:transportClient = [Activator]::CreateInstance($transportClientType)
    Bind-AnonymousTransport $script:transportClient
}
function Send-AnonymousTransport([byte[]]$Bytes = [Text.Encoding]::UTF8.GetBytes($transportText), [object]$Client = $script:transportClient) {
    $methods['BeforeUpsertTransportRequest'].Invoke($null,[object[]]@($Client,$Bytes,'ANONYMOUS-ACTUAL-TRANSPORT-AGENT',$true)) | Out-Null
}
function Prepare-AnonymousResponse([string]$Response = $transportResponse,[object]$Client = $script:transportClient) {
    $actual = [Text.Encoding]::UTF8.GetBytes($Response)
    $capacity = [byte[]]($actual + [Text.Encoding]::UTF8.GetBytes(' ignored-capacity-tail {"returnCode":2}'))
    $transportFields['state_'].SetValue($Client,[int]3)
    $transportFields['errorCode_'].SetValue($Client,[int]0)
    $transportFields['httpStatusCode_'].SetValue($Client,[int]200)
    $transportFields['responseLength_'].SetValue($Client,[int]$actual.Length)
    $transportFields['response_'].SetValue($Client,$capacity)
}
function Complete-AnonymousTransport([object]$Client = $script:transportClient) {
    $methods['AfterUpsertTransportCompleted'].Invoke($null,@($Client)) | Out-Null
}
Assert-Capture ($null -ne $methods['UpsertHttpFactoryMethod'].Invoke($null,@($transportClientType)) -and $null -ne $methods['UpsertHttpRequestMethod'].Invoke($null,@($transportClientType)) -and $null -ne $methods['UpsertHttpCompletedMethod'].Invoke($null,@($transportClientType)) -and $null -ne $methods['UpsertResetMethod'].Invoke($null,@($transportPacketType))) 'transport signatures match native static class factory large send completion and boolean reset'
Assert-Capture ($null -eq $methods['UpsertHttpRequestMethod'].Invoke($null,@([CaptureFakeWrongUpsert])) -and $null -eq $methods['UpsertHttpCompletedMethod'].Invoke($null,@([CaptureFakePreviewResponse]))) 'transport hook validation rejects unrelated or incompatible field and method shapes'
$beforeTransport = Count-UpsertFiles
$ordinaryBeforeTransport = @{}
foreach ($name in @('session','sequence','player','status','loginIdentity','previewSequence','pendingMachine')) { $ordinaryBeforeTransport[$name] = $fields[$name].GetValue($null) }
Start-AnonymousTransport
$requestBytes = [Text.Encoding]::UTF8.GetBytes($transportText)
Send-AnonymousTransport $requestBytes
$requestBytes[0] = [byte]0
$methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,'{"userId":43}')) | Out-Null
$methods['UpsertUserAgent'].Invoke($null,@($upsert.PSObject.BaseObject,'ANONYMOUS-LATER-CALCULATED-AGENT')) | Out-Null
Assert-Capture ($upsertObservations[$upsert.PSObject.BaseObject].SerializedRequest -ceq $transportText -and $upsertObservations[$upsert.PSObject.BaseObject].Agent -ceq 'ANONYMOUS-ACTUAL-TRANSPORT-AGENT') 'later optional serializer or agent observations cannot overwrite the exact actual client send evidence'
Prepare-AnonymousResponse
$nativeResponseField = $nativeQueryType.GetField('response_')
$nativeResponseBox = $nativeResponseField.GetValue($upsert)
$nativeResponseBox.returnCode = [int]2
$nativeResponseField.SetValue($upsert,$nativeResponseBox)
Complete-AnonymousTransport
Assert-Capture ((Count-UpsertFiles) -eq ($beforeTransport + 1) -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) 'actual send bytes and completed transport response publish once without relying on native query parsed fields'
$transportRecords = @(Get-ChildItem -LiteralPath $upsertDirectory -Filter '*.json' | ForEach-Object { [IO.File]::ReadAllText($_.FullName) | ConvertFrom-Json } | Where-Object { $_.source -eq 'game-transport-success-response' })
Assert-Capture ($transportRecords.Count -eq 1 -and $transportRecords[0].observationPath -eq 'net-http-request-completed' -and $transportRecords[0].acceptance -eq 'transport-success-return-code' -and $transportRecords[0].compressionRequested) 'actual transport has an accurate fixed source path acceptance and observed compression request'
Assert-Capture ($transportRecords[0].serializedRequest -ceq $transportText -and $transportRecords[0].serializedResponse -ceq $transportResponse -and $transportRecords[0].connection.userAgent -ceq 'ANONYMOUS-ACTUAL-TRANSPORT-AGENT') 'transport copies immutable original UTF8 request UA and exactly the response length without capacity tail'
Complete-AnonymousTransport
Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles) -eq ($beforeTransport + 1)) 'transport and optional query hook responses share one consumed lifetime without duplicate publication'
$ordinaryStable = $true
foreach ($name in $ordinaryBeforeTransport.Keys) { if ($fields[$name].GetValue($null) -ne $ordinaryBeforeTransport[$name]) { $ordinaryStable = $false } }
Assert-Capture $ordinaryStable 'transport observer leaves ordinary player session status Preview and machine observation unchanged'
Start-AnonymousTransport
$foreignClient = [Activator]::CreateInstance($transportClientType)
Send-AnonymousTransport ([Text.Encoding]::UTF8.GetBytes($transportText)) $foreignClient
Prepare-AnonymousResponse $transportResponse $foreignClient
Complete-AnonymousTransport $foreignClient
Assert-Capture ($upsertObservations.Count -eq 1 -and !$upsertObservations[$upsert.PSObject.BaseObject].TransportRequestObserved -and (Count-UpsertFiles) -eq ($beforeTransport + 1)) 'a value-equal foreign actual client cannot borrow the query request or response'
Send-AnonymousTransport
Prepare-AnonymousResponse
Complete-AnonymousTransport
Assert-Capture ((Count-UpsertFiles) -eq ($beforeTransport + 2)) 'the original exact client still completes after a foreign response is ignored'
foreach ($badRequest in @($transportText.Replace('"userId":42','"userId":43'),$transportText.Replace('"regionId":1','"regionId":2'),$transportText.Replace('"placeId":3','"placeId":4'),$transportText.Replace('"userId":42','"userId":42,"userId":42'),$transportText.Replace('"userId":42','"userId":"42"'),$transportText.Replace('"accessCode":"10000000000000000001"','"accessCode":"10000000000000000002"'))) {
    Start-AnonymousTransport
    Send-AnonymousTransport ([Text.Encoding]::UTF8.GetBytes($badRequest))
    Prepare-AnonymousResponse
    Complete-AnonymousTransport
    Assert-Capture ($upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq ($beforeTransport + 2)) 'actual request owner context wrong type and duplicate identity keys fail closed'
}
foreach ($badResponse in @('{"returnCode":2}','{"returnCode":"1"}','{"returnCode":1.0}','{"returnCode":1e0}','{"returnCode":1,"returnCode":1}','{"returnCode":1,"userId":43}','{"returnCode":1,}','{"returnCode":1} trailing')) {
    Start-AnonymousTransport
    Send-AnonymousTransport
    Prepare-AnonymousResponse $badResponse
    Complete-AnonymousTransport
    Assert-Capture ($upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq ($beforeTransport + 2)) 'only strict original response object with one numeric integer code and matching optional owner is confirmed'
}
foreach ($invalidField in @('state_','errorCode_','httpStatusCode_','responseLength_','response_')) {
    Start-AnonymousTransport
    Send-AnonymousTransport
    Prepare-AnonymousResponse
    switch ($invalidField) {
        'state_' { $transportFields[$invalidField].SetValue($transportClient,[int]6) }
        'errorCode_' { $transportFields[$invalidField].SetValue($transportClient,[int]1) }
        'httpStatusCode_' { $transportFields[$invalidField].SetValue($transportClient,[int]500) }
        'responseLength_' { $transportFields[$invalidField].SetValue($transportClient,[int]999999) }
        'response_' { $transportFields[$invalidField].SetValue($transportClient,[byte[]]@(0xc3,0x28)); $transportFields['responseLength_'].SetValue($transportClient,[int]2) }
    }
    Complete-AnonymousTransport
    Assert-Capture ($upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq ($beforeTransport + 2)) ('native unsuccessful or malformed completed response is not published: ' + $invalidField)
}
Start-AnonymousTransport
Send-AnonymousTransport ([byte[]]@(0xc3,0x28))
Assert-Capture ($upsertObservations.Count -eq 0) 'malformed request UTF8 fails closed without changing the source buffer'
Start-AnonymousTransport
Send-AnonymousTransport
$oldClient = $transportClient
$oldStarted = $upsertObservationType.GetField('Started').GetValue($upsertObservations[$upsert.PSObject.BaseObject])
$oldLifetime = $upsertObservationType.GetField('Lifetime').GetValue($upsertObservations[$upsert.PSObject.BaseObject])
$retryClient = [Activator]::CreateInstance($transportClientType)
$retryPacket = [Activator]::CreateInstance($transportPacketType,[object[]]@($upsert.PSObject.BaseObject))
$resetArguments = [object[]]@($retryPacket,$null)
$methods['BeginUpsertReset'].Invoke($null,$resetArguments) | Out-Null
$resetState = $resetArguments[1]
try { $methods['CreatedUpsertClient'].Invoke($null,[object[]]@($retryClient,$factoryArgs)) | Out-Null }
finally { $methods['EndUpsertReset'].Invoke($null,@($resetState)) | Out-Null }
Assert-Capture ($upsertObservations.Count -eq 1 -and !$upsertObservations[$upsert.PSObject.BaseObject].TransportRequestObserved -and $upsertObservations[$upsert.PSObject.BaseObject].Started -eq $oldStarted -and [object]::ReferenceEquals($upsertObservations[$upsert.PSObject.BaseObject].Lifetime,$oldLifetime) -and !$fields['resetContextActive'].GetValue($null)) 'explicit native reset replaces only its exact client without extending first generation or expiry'
Prepare-AnonymousResponse $transportResponse $oldClient
Complete-AnonymousTransport $oldClient
Assert-Capture ($upsertObservations.Count -eq 1 -and (Count-UpsertFiles) -eq ($beforeTransport + 2)) 'retired old client response cannot publish a later retry request'
$script:transportClient = $retryClient
Send-AnonymousTransport
Prepare-AnonymousResponse
Complete-AnonymousTransport
Assert-Capture ((Count-UpsertFiles) -eq ($beforeTransport + 3)) 'the exact replacement client can publish its own actual bytes and successful response'
Start-AnonymousTransport
$deadHttp = $nativeFixture.GetType('MU3.Client.AnonymousWeakProbe',$true).GetMethod('MakeHttpWeak').Invoke($null,@())
[GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()
Assert-Capture (!$deadHttp.IsAlive) 'an anonymous unowned native-shaped client is genuinely collectible'
$upsertObservationType.GetField('TransportClient').SetValue($upsertObservations[$upsert.PSObject.BaseObject],$deadHttp)
Bind-AnonymousTransport ([Activator]::CreateInstance($transportClientType))
Assert-Capture ($upsertObservations.Count -eq 0 -and [IO.File]::ReadAllText((Join-Path $fixtureRoot 'upsert-capture-status.txt')).Trim() -eq 'transport-client-replaced') 'a previously bound collected client cannot be replaced outside explicit reset'
Start-AnonymousTransport
$resetArguments = [object[]]@([Activator]::CreateInstance($transportPacketType,[object[]]@($upsert.PSObject.BaseObject)),$null)
$methods['BeginUpsertReset'].Invoke($null,$resetArguments) | Out-Null
$originalException = New-Object InvalidOperationException 'anonymous native reset failure'
$returnedException = $methods['FinalizeUpsertReset'].Invoke($null,@($originalException.PSObject.BaseObject,$resetArguments[1]))
Assert-Capture ([object]::ReferenceEquals($returnedException.PSObject.BaseObject,$originalException.PSObject.BaseObject) -and !$fields['resetContextActive'].GetValue($null) -and $null -eq $fields['resetUpsertQuery'].GetValue($null) -and $null -eq $fields['activeQuery'].GetValue($null)) 'exceptional reset restores only diagnostic context and preserves the original exception and core context'
$methods['Login'].Invoke($null,@($login.PSObject.BaseObject,$true)) | Out-Null
foreach ($transportBoundary in @('age','login','runLimit','requestLimit','responseLimit')) {
    Start-AnonymousTransport
    Send-AnonymousTransport
    Prepare-AnonymousResponse
    switch ($transportBoundary) {
        'age' { $obs = $upsertObservations[$upsert.PSObject.BaseObject]; $oldTime=[DateTime]::UtcNow.AddMinutes(-3); $upsertObservationType.GetField('Started').SetValue($obs,$oldTime); $obs.Lifetime.GetType().GetField('Started').SetValue($obs.Lifetime,$oldTime) }
        'login' { $methods['Login'].Invoke($null,@($login.PSObject.BaseObject,$true)) | Out-Null }
        'runLimit' { $fields['upsertSequence'].SetValue($null,[int]32) }
        'requestLimit' { Send-AnonymousTransport (New-Object byte[] (8*1024*1024+1)) }
        'responseLimit' { $transportFields['response_'].SetValue($transportClient,(New-Object byte[] (1024*1024+1))); $transportFields['responseLength_'].SetValue($transportClient,[int](1024*1024+1)) }
    }
    Complete-AnonymousTransport
    Assert-Capture ((Count-UpsertFiles) -eq ($beforeTransport + 3) -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0) ('actual transport remains bounded by owner generation TTL run and byte limits: ' + $transportBoundary)
    $fields['upsertSequence'].SetValue($null,[int]3)
}
$budgetPrefix = $transportText.Substring(0,$transportText.LastIndexOf('}')) + ',"padding":"'
$budgetSuffix = '"}'
$budgetUtf8Length = [Text.Encoding]::UTF8.GetByteCount($budgetPrefix+$budgetSuffix)
$actualBudgetRequest = [Text.Encoding]::UTF8.GetBytes($budgetPrefix + ('x' * (8*1024*1024-$budgetUtf8Length)) + $budgetSuffix)
for ($i=0;$i -lt 3;$i++) { Start-AnonymousTransport; Send-AnonymousTransport $actualBudgetRequest }
Assert-Capture ($upsertObservations.Count -eq 2 -and $fields['upsertRequestBytes'].GetValue($null) -eq (16*1024*1024)) 'actual transport copies share the same sixteen MiB pending request budget'
$methods['Login'].Invoke($null,@($login.PSObject.BaseObject,$true)) | Out-Null
Assert-Capture ($transportClientType.GetField('methodCalls').GetValue($null) -eq 0 -and $nativePayloadType.GetField('serializerCalls').GetValue($null) -eq 0) 'all fake native factories sends getters completions resets and serializers remain uncalled'
# Typed anonymous observations only: none of these tests invokes a game method,
# Unity JsonUtility, AMDaemon native function, network request or real backup.
$anonymousGame = [IO.Path]::GetFullPath((Join-Path $fixtureRoot 'anonymous-game'))
foreach ($path in @('mu3_Data/Managed','mu3_Data/Mono','appdata/SDDT')) { New-Item -ItemType Directory -Path (Join-Path $anonymousGame $path) -Force | Out-Null }
foreach ($path in @('mu3_Data/Managed/Assembly-CSharp.dll','mu3_Data/Managed/mscorlib.dll','mu3_Data/Mono/mono.dll','mu3hook.dll','mu3.ini')) { [IO.File]::WriteAllText((Join-Path $anonymousGame $path), 'anonymous fixture bytes') }
$machineIni = Join-Path $anonymousGame 'segatools.ini'
[IO.File]::WriteAllText($machineIni, "[vfs]`nappdata=appdata`n")
$anonymousBackup = Join-Path $anonymousGame 'appdata/SDDT/appfile.dat'
$stream = [IO.File]::Open($anonymousBackup, [IO.FileMode]::Create); try { $stream.SetLength(8 * 1024 * 1024) } finally { $stream.Dispose() }
$fields['gameRoot'].SetValue($null, $anonymousGame.ToString())
$fields['backupFile'].SetValue($null, $anonymousBackup.ToString())
$startup = $methods['Fingerprints'].Invoke($null, @($anonymousGame.ToString()))
$fields['startupFingerprints'].SetValue($null, $startup.ToString())
$fields['nativeBackup'].SetValue($null, [CaptureFakeNativeBackup])
$fields['machineHooks'].SetValue($null, $true)
$machineTarget = Join-Path $fixtureRoot 'machine-context.json'
function Start-AnonymousMachineSave {
    $script:packet = New-Object CaptureFakePacket
    $script:setting = New-Object CaptureFakeSetting
    $script:nativeState = New-Object CaptureFakeNativeState
    $script:nativeState.Pointer = [IntPtr]42
    [CaptureFakeNativeBackup]::LastSaveState = $script:nativeState
    [CaptureFakeNativeBackup]::IsBusy = $false
    $methods['BeforeAcceptedSave'].Invoke($null, @($script:packet.PSObject.BaseObject)) | Out-Null
    $methods['AfterSerialIncrement'].Invoke($null, @($script:setting.PSObject.BaseObject)) | Out-Null
    $methods['AfterNativeSave'].Invoke($null, @([int]3,$true)) | Out-Null
}
Start-AnonymousMachineSave
$methods['TryObserveMachineFlush'].Invoke($null, @()) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath $machineTarget)) 'accepted native queue is not a completed backup'
$nativeState.IsDone = $true; $nativeState.IsSucceeded = $true; [CaptureFakeNativeBackup]::IsBusy = $true
$methods['TryObserveMachineFlush'].Invoke($null, @()) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath $machineTarget)) 'busy backup cannot publish counter'
[CaptureFakeNativeBackup]::IsBusy = $false; $setting.dirty = $true
$methods['TryObserveMachineFlush'].Invoke($null, @()) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath $machineTarget)) 'dirty SettingExt cannot publish counter'
$setting.dirty = $false
# Match amdaemon retaining a writable handle even when its request is done.
$heldBackup = [IO.File]::Open($anonymousBackup, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
try { $methods['TryObserveMachineFlush'].Invoke($null, @()) | Out-Null }
finally { $heldBackup.Dispose() }
Assert-Capture (Test-Path -LiteralPath $machineTarget) 'completed backup remains observable while amdaemon retains its writable file handle'
$machineText = [IO.File]::ReadAllText($machineTarget); $machine = $machineText | ConvertFrom-Json
Assert-Capture ($machine.version -eq 1 -and $machine.source -eq 'game-backup-flushed' -and $machine.clientSystemInfo.count -eq 8 -and $machine.clientSystemInfo.flags -eq 12) 'cache copies actual six fields with post-increment getter count'
Assert-Capture (($machine.clientSystemInfo.PSObject.Properties.Name -join ',') -eq 'boardId,count,flags,version,machineName,userName' -and $machineText -notmatch 'unrelated|userId|accessCode|123456') 'machine cache excludes player card request and unrelated fields'
Assert-Capture (($machine.fingerprints.PSObject.Properties.Name -join ',') -eq 'root,assembly,segatools,mu3,hook,mono,coreLibrary,backup' -and @($machine.fingerprints.PSObject.Properties | Where-Object { $_.Value -notmatch '^[a-f0-9]{64}$' }).Count -eq 0) 'eight hashes bind root configuration runtime and native backup'
Remove-Item -LiteralPath $machineTarget
$methods['TryObserveMachineFlush'].Invoke($null, @()) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath $machineTarget)) 'same observation never recreates a consumed cache'
Start-AnonymousMachineSave
$nativeState.Pointer = [IntPtr]43; $nativeState.IsDone = $true; $nativeState.IsSucceeded = $true
$methods['TryObserveMachineFlush'].Invoke($null, @()) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath $machineTarget) -and $null -eq $fields['pendingMachine'].GetValue($null)) 'reused LastSaveState pointer cannot prove original request completion'
Start-AnonymousMachineSave
$nativeState.IsDone = $true; $nativeState.IsSucceeded = $false
$methods['TryObserveMachineFlush'].Invoke($null, @()) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath $machineTarget)) 'failed native backup never publishes cache'
Start-AnonymousMachineSave
$nativeState.IsDone = $true; $nativeState.IsSucceeded = $true; $setting.count = 9
$methods['TryObserveMachineFlush'].Invoke($null, @()) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath $machineTarget)) 'later counter change invalidates pending observation'
Start-AnonymousMachineSave
$nativeState.IsDone = $true; $nativeState.IsSucceeded = $true
[IO.File]::WriteAllText((Join-Path $anonymousGame 'mu3.ini'), 'changed anonymous configuration')
$methods['TryObserveMachineFlush'].Invoke($null, @()) | Out-Null
Assert-Capture (!(Test-Path -LiteralPath $machineTarget)) 'startup configuration mutation prevents publication'
$invalidInfo = New-Object CaptureFakeMachineInfo; $invalidInfo.flags = 16
$rejected = $false; try { $methods['ReadMachineObservation'].Invoke($null, @($invalidInfo.PSObject.BaseObject)) | Out-Null } catch { $rejected = $true }
Assert-Capture $rejected 'out-of-range flags are rejected without inventing replacement fields'
$fields['machineHooks'].SetValue($null, $false)
$methods['BeforeAcceptedSave'].Invoke($null, @((New-Object CaptureFakePacket).PSObject.BaseObject)) | Out-Null
Assert-Capture ($null -eq $fields['pendingMachine'].GetValue($null)) 'unavailable optional observer remains inert'
# The old 166 checks run unchanged first. This exact typed-struct/client scene
# exposes the 1.0.9 silent-retirement stage without claiming a live game cause.
$priorChecks = $checks.Count
$nativeLifetimes.Clear()
$fields['upsertSequence'].SetValue($null,[int]0)
$fields['machineSnapshot'].SetValue($null,$snapshot.ToString())
$methods['Login'].Invoke($null,@($login.PSObject.BaseObject,$true)) | Out-Null
$diagnosticPath = Join-Path $fixtureRoot 'upsert-hook-diagnostics.json'
function Read-UpsertStage { [IO.File]::ReadAllText((Join-Path $fixtureRoot 'upsert-capture-status.txt')).Trim() }
function Read-UpsertDiagnostic { [IO.File]::ReadAllText($diagnosticPath) | ConvertFrom-Json }
Start-AnonymousTransport
$diagnosticStartFiles = Count-UpsertFiles
$methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,'')) | Out-Null
$regressionStage = Read-UpsertStage
$regressionReason = 'unavailable'
if (Test-Path -LiteralPath $diagnosticPath) { $regressionReason = (Read-UpsertDiagnostic).lastReason }
[ordered]@{ priorChecks=$priorChecks; scenario='typed-struct-bound-client-legacy-empty-request'; expectedNewStage='rejected-legacy-request-empty'; observedStage=$regressionStage; observedReason=$regressionReason; pendingQueries=$upsertObservations.Count; sampleCountChanged=((Count-UpsertFiles) -ne $diagnosticStartFiles); gameExecuted=$false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'guard-regression-observation.json') -Encoding UTF8
Assert-Capture ($regressionStage -eq 'rejected-legacy-request-empty' -and $regressionReason -eq 'legacy-request-empty' -and $upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq $diagnosticStartFiles) 'previous client-observed silent retirement now exposes its precise empty legacy request guard'
$witnesses = [Collections.IList]$fields['UpsertClientWitnesses'].GetValue($null)
$witnessType = $type.GetNestedType('UpsertClientWitness',[Reflection.BindingFlags]::NonPublic)
$firstReason = (Read-UpsertDiagnostic).lastReason
$methods['UpsertUserAgent'].Invoke($null,@($upsert.PSObject.BaseObject,'ANONYMOUS-LATE-AGENT')) | Out-Null
$methods['RememberUpsertQuery'].Invoke($null,@($upsert.PSObject.BaseObject,$upsertConnection)) | Out-Null
Send-AnonymousTransport
Prepare-AnonymousResponse
Complete-AnonymousTransport
$lateDiagnostic = Read-UpsertDiagnostic
Assert-Capture ((Read-UpsertStage) -eq $regressionStage -and $lateDiagnostic.lastReason -eq $firstReason -and $lateDiagnostic.lastWitnessAvailable -and $lateDiagnostic.lastRetiredSendEntered -and $lateDiagnostic.lastRetiredCompletedEntered -and $upsertObservations.Count -eq 0 -and (Count-UpsertFiles) -eq $diagnosticStartFiles) 'late serializer agent sender and completed callbacks preserve first rejection and only record exact retired client entry'
$foreignClient = [Activator]::CreateInstance($transportClientType)
$beforeForeign = Read-UpsertDiagnostic
$beforeForeignText = [IO.File]::ReadAllText($diagnosticPath)
$sendGlobalBefore = $fields['transportSendEntries'].GetValue($null)
$completeGlobalBefore = $fields['transportCompletedEntries'].GetValue($null)
Send-AnonymousTransport ([Text.Encoding]::UTF8.GetBytes($transportText)) $foreignClient
Prepare-AnonymousResponse $transportResponse $foreignClient
Complete-AnonymousTransport $foreignClient
$afterForeignText = [IO.File]::ReadAllText($diagnosticPath)
Assert-Capture ($afterForeignText -ceq $beforeForeignText -and (Read-UpsertStage) -eq $regressionStage -and $fields['transportRetiredSends'].GetValue($null) -eq $beforeForeign.retiredSendEntries -and $fields['transportRetiredCompletions'].GetValue($null) -eq $beforeForeign.retiredCompletedEntries -and $fields['transportSendEntries'].GetValue($null) -eq ($sendGlobalBefore+1) -and $fields['transportCompletedEntries'].GetValue($null) -eq ($completeGlobalBefore+1)) 'unbound value-equal ordinary HTTP counts only global entries and never rewrites Upsert reason or witnesses'
$methods['WriteUpsertDiagnostics'].Invoke($null,@()) | Out-Null
$anonymousDiagnosticText = [IO.File]::ReadAllText($diagnosticPath)
$anonymousDiagnostic = Read-UpsertDiagnostic
$diagnosticNames = 'version,source,lastReason,sendHookEntries,completedHookEntries,boundSendEntries,boundCompletedEntries,retiredSendEntries,retiredCompletedEntries,retiredWitnessCount,lastWitnessAvailable,lastRetiredSendEntered,lastRetiredCompletedEntered'
Assert-Capture (($anonymousDiagnostic.PSObject.Properties.Name -join ',') -eq $diagnosticNames -and $anonymousDiagnostic.source -eq 'passive-upsert-hook-diagnostics' -and $anonymousDiagnosticText -notmatch 'ANONYMOUS|userId|accessCode|clientId|identity|nonce_|upsert.invalid|server-a|A123|100000|serializedRequest|baseUrl|userAgent|loginGeneration') 'anonymous diagnostic schema contains only fixed reasons counts and booleans with no player routing or raw data'
foreach ($property in $anonymousDiagnostic.PSObject.Properties) {
    $expectedType = if ($property.Name -in @('source','lastReason')) { [string] } elseif ($property.Name -in @('lastWitnessAvailable','lastRetiredSendEntered','lastRetiredCompletedEntered')) { [bool] } else { [int] }
    Assert-Capture ($property.Value -is $expectedType) ('anonymous diagnostic fixed field type: ' + $property.Name)
}
# A query that never obtained a pending observation must still publish its
# first fixed refusal, rather than treating its own retirement as a replay.
$nativeLifetimes.Clear()
$heldPending=New-Object 'System.Collections.Generic.List[object]'
for ($i=0;$i -lt 64;$i++) { Start-NativeUpsert; $heldPending.Add($upsert) }
Start-NativeUpsert
Assert-Capture ($upsertObservations.Count -eq 64 -and !$upsertObservations.ContainsKey($upsert.PSObject.BaseObject) -and (Read-UpsertDiagnostic).lastReason -eq 'pending-query-limit' -and (Read-UpsertStage) -eq 'rejected-pending-query-limit' -and (Count-UpsertFiles) -eq $diagnosticStartFiles) 'sixty-fifth query without pending observation records its first precise pending limit rejection'
$methods['Login'].Invoke($null,@($login.PSObject.BaseObject,$true)) | Out-Null
foreach ($unmappedGuard in @('source-generation','lifetime-expired')) {
    $nativeLifetimes.Clear()
    $script:upsert=[Activator]::CreateInstance($nativeQueryType)
    $unmappedLifetime=$methods['UpsertQueryLifetime'].Invoke($null,@($upsert.PSObject.BaseObject))
    if ($unmappedGuard -eq 'source-generation') { $nativeLifetimeType.GetField('Generation').SetValue($unmappedLifetime,'anonymous-previous-generation') }
    else { $nativeLifetimeType.GetField('Started').SetValue($unmappedLifetime,[DateTime]::UtcNow.AddMinutes(-3)) }
    $methods['RememberUpsertQuery'].Invoke($null,@($upsert.PSObject.BaseObject,$upsertConnection)) | Out-Null
    Assert-Capture ($upsertObservations.Count -eq 0 -and $nativeLifetimeType.GetField('Retired').GetValue($unmappedLifetime) -and (Read-UpsertDiagnostic).lastReason -eq $unmappedGuard -and (Read-UpsertStage) -eq ('rejected-'+$unmappedGuard) -and (Count-UpsertFiles) -eq $diagnosticStartFiles) ('first unmapped lifetime guard records refusal before retirement: '+$unmappedGuard)
}
# Guard reasons are checked independently of the transport stage compatibility
# strings; the original bounds and original exact ownership remain required.
foreach ($guardCase in @('owner-user','owner-card','owner-client','request-region','request-place','request-payload-reference','request-payload-field-reference','request-payload-marker','source-machine','source-identity','lifetime-expired','legacy-agent-invalid','legacy-request-character-limit','legacy-request-utf8-limit','legacy-response-empty','legacy-response-character-limit','legacy-response-utf8-limit','legacy-response-parser-not-confirmed','legacy-response-code-not-one','connection-invalid','legacy-request-budget')) {
    Start-AnonymousTransport
    if ($guardCase -in @('request-payload-field-reference','request-payload-marker')) { Observe-AnonymousUpsert }
    $savedIdentity = $fields['loginIdentity'].GetValue($null)
    $savedMachine = $fields['machineSnapshot'].GetValue($null)
    switch ($guardCase) {
        'owner-user' { Set-NativeUpsertField 'userId' ([long]43) }
        'owner-card' { Set-NativeUpsertField 'accessCode' '10000000000000000002' }
        'owner-client' { Set-NativeUpsertField 'clientId' 'A1234567891' }
        'request-region' { Set-NativeUpsertField 'regionId' ([int]2) }
        'request-place' { Set-NativeUpsertField 'placeId' ([uint32]4) }
        'request-payload-reference' { Set-NativeUpsertField 'upsertUserAll' ([Activator]::CreateInstance($nativePayloadType)) }
        'request-payload-field-reference' { $payload=$nativeRequestField.GetValue($upsert).upsertUserAll; $nativePayloadType.GetField('userData').SetValue($payload,[object[]]@(New-Object object)) }
        'request-payload-marker' { $payload=$nativeRequestField.GetValue($upsert).upsertUserAll; $nativePayloadType.GetField('isNewMusicDetailList').SetValue($payload,'1') }
        'source-machine' { $fields['machineSnapshot'].SetValue($null,'{}') }
        'source-identity' { $fields['loginIdentity'].SetValue($null,'{}') }
        'lifetime-expired' { $obs=$upsertObservations[$upsert.PSObject.BaseObject]; $oldTime=[DateTime]::UtcNow.AddMinutes(-3); $upsertObservationType.GetField('Started').SetValue($obs,$oldTime); $obs.Lifetime.GetType().GetField('Started').SetValue($obs.Lifetime,$oldTime) }
        'legacy-agent-invalid' { $methods['UpsertUserAgent'].Invoke($null,@($upsert.PSObject.BaseObject,'')) | Out-Null }
        'legacy-request-character-limit' { $methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,('x' * (8*1024*1024+1)))) | Out-Null }
        'legacy-request-utf8-limit' { $methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,(([string][char]0x754c) * 2800000))) | Out-Null }
        'legacy-response-empty' { Complete-AnonymousUpsert $true '' }
        'legacy-response-character-limit' { Complete-AnonymousUpsert $true ('x' * (1024*1024+1)) }
        'legacy-response-utf8-limit' { Complete-AnonymousUpsert $true (([string][char]0x754c) * 350000) }
        'legacy-response-parser-not-confirmed' { Complete-AnonymousUpsert $false }
        'legacy-response-code-not-one' { Observe-AnonymousUpsert; $responseBox=$nativeResponseField.GetValue($upsert); $responseBox.returnCode=[int]2; $nativeResponseField.SetValue($upsert,$responseBox); Complete-AnonymousUpsert }
        'connection-invalid' { $connectionType.GetField('Encryption').SetValue($upsertConnection,[int]-1); $methods['RememberUpsertQuery'].Invoke($null,@($upsert.PSObject.BaseObject,$upsertConnection)) | Out-Null }
        'legacy-request-budget' { $fields['upsertRequestBytes'].SetValue($null,[int](16*1024*1024)); $methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,$serializedUpsert)) | Out-Null; $fields['upsertRequestBytes'].SetValue($null,[int]0) }
    }
    if ($upsertObservations.Count -gt 0) { $methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,$serializedUpsert)) | Out-Null }
    Assert-Capture ((Read-UpsertDiagnostic).lastReason -eq $guardCase -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0 -and (Count-UpsertFiles) -eq $diagnosticStartFiles) ('specific former silent guard retires without fabricated samples: ' + $guardCase)
    $fields['loginIdentity'].SetValue($null,$savedIdentity)
    $fields['machineSnapshot'].SetValue($null,$savedMachine)
}
Start-AnonymousTransport
$methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,'')) | Out-Null
$latestWitness = $fields['lastClientWitness'].GetValue($null)
$witnessType.GetField('RetiredAt').SetValue($latestWitness,[DateTime]::UtcNow.AddMinutes(-3))
$retiredEntriesBefore=$fields['transportRetiredSends'].GetValue($null)
Send-AnonymousTransport
$methods['WriteUpsertDiagnostics'].Invoke($null,@()) | Out-Null
Assert-Capture (!$witnesses.Contains($latestWitness) -and !(Read-UpsertDiagnostic).lastWitnessAvailable -and (Read-UpsertDiagnostic).lastReason -eq 'legacy-request-empty' -and $fields['transportRetiredSends'].GetValue($null) -eq $retiredEntriesBefore) 'retired-client evidence expires after two minutes without losing original fixed reason or resurrecting query'
$weakWitnessOnly=$true
foreach ($field in $witnessType.GetFields()) {
    if ($field.FieldType -notin @([WeakReference],[string],[DateTime],[bool])) { $weakWitnessOnly=$false }
}
Assert-Capture $weakWitnessOnly 'retired client evidence has no strong client query payload card or request reference'
$witnesses.Clear()
$deadWitness=[Activator]::CreateInstance($witnessType,$true)
$deadClientWeak=$nativeFixture.GetType('MU3.Client.AnonymousWeakProbe',$true).GetMethod('MakeHttpWeak').Invoke($null,@())
[GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()
$witnessType.GetField('Client').SetValue($deadWitness,$deadClientWeak)
$witnessType.GetField('Generation').SetValue($deadWitness,$fields['loginGeneration'].GetValue($null))
$witnessType.GetField('RetiredAt').SetValue($deadWitness,[DateTime]::UtcNow)
$witnesses.Add($deadWitness) | Out-Null
$methods['PruneUpsertWitnesses'].Invoke($null,@()) | Out-Null
Assert-Capture (!$deadClientWeak.IsAlive -and $witnesses.Count -eq 0) 'dead exact client witness is collectible and pruned without retaining native objects'
# Populate only anonymous known-bound retired clients, keeping weak targets
# alive to isolate the distinct witness cap. The earlier checks separately
# prove the production query-lifetime limit; this fixture resets that registry.
$heldWitnessClients=New-Object 'System.Collections.Generic.List[object]'
for ($i=0;$i -lt 257;$i++) {
    $nativeLifetimes.Clear()
    Start-AnonymousTransport
    $heldWitnessClients.Add($transportClient)
    $methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,'')) | Out-Null
}
Assert-Capture ($witnesses.Count -eq 256 -and $upsertObservations.Count -eq 0 -and (Read-UpsertDiagnostic).lastReason -eq 'legacy-request-empty' -and (Count-UpsertFiles) -eq $diagnosticStartFiles) 'known-bound weak retired client witnesses remain independently capped at 256 without publishing samples'
$methods['Login'].Invoke($null,@($login.PSObject.BaseObject,$true)) | Out-Null
$methods['WriteUpsertDiagnostics'].Invoke($null,@()) | Out-Null
Assert-Capture ($witnesses.Count -eq 0 -and !(Read-UpsertDiagnostic).lastWitnessAvailable -and (Read-UpsertDiagnostic).lastReason -eq 'none') 'new accepted login removes prior-generation retired evidence and reason without relinking clients'
$nativeLifetimes.Clear()
Start-AnonymousTransport; Send-AnonymousTransport; Prepare-AnonymousResponse; Complete-AnonymousTransport
$afterDiagnosticSuccess=Count-UpsertFiles
Complete-AnonymousTransport; Complete-AnonymousUpsert
$methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,'')) | Out-Null
Assert-Capture ((Read-UpsertStage) -eq 'captured' -and (Read-UpsertDiagnostic).lastReason -eq 'none' -and (Count-UpsertFiles) -eq $afterDiagnosticSuccess -and $upsertObservations.Count -eq 0) 'successful consumed lifetime and duplicate later callbacks retain captured state without a fabricated rejection'
Assert-Capture ($transportClientType.GetField('methodCalls').GetValue($null) -eq 0 -and $nativePayloadType.GetField('serializerCalls').GetValue($null) -eq 0) 'guard diagnostics invoke none of the throwing native-shaped methods or serializers'
# Anonymous IO fault: a regular file occupies the publication directory. Both
# already consumed routes must expose the current write failure, no raw error,
# while duplicate callbacks cannot recreate ownership or publish later.
$ioFixtureRoot=Join-Path $fixtureRoot 'publication-io-fixture'
New-Item -ItemType Directory -Path $ioFixtureRoot | Out-Null
[IO.File]::WriteAllText((Join-Path $ioFixtureRoot 'capture.enabled'),'1')
[IO.File]::WriteAllText((Join-Path $ioFixtureRoot 'upsert-observations'),'anonymous directory conflict')
$ioBeforeFiles=Count-UpsertFiles
$fields['root'].SetValue($null,$ioFixtureRoot.ToString())
try {
    foreach ($publicationRoute in @('transport','query')) {
        Start-AnonymousTransport
        if ($publicationRoute -eq 'transport') { Send-AnonymousTransport; Prepare-AnonymousResponse; Complete-AnonymousTransport }
        else { Observe-AnonymousUpsert; Complete-AnonymousUpsert }
        $ioDiagnosticText=[IO.File]::ReadAllText((Join-Path $ioFixtureRoot 'upsert-hook-diagnostics.json'))
        $ioDiagnostic=$ioDiagnosticText | ConvertFrom-Json
        $ioStage=[IO.File]::ReadAllText((Join-Path $ioFixtureRoot 'upsert-capture-status.txt')).Trim()
        Complete-AnonymousTransport; Complete-AnonymousUpsert
        $methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,$serializedUpsert)) | Out-Null
        Assert-Capture ($ioDiagnostic.lastReason -eq 'publication-write-failed' -and $ioDiagnosticText -notmatch 'Exception|publication-io-fixture|anonymous directory conflict|ANONYMOUS|serializedRequest|accessCode|baseUrl' -and $upsertObservations.Count -eq 0 -and $fields['upsertRequestBytes'].GetValue($null) -eq 0 -and (Count-UpsertFiles) -eq $ioBeforeFiles -and [IO.File]::Exists((Join-Path $ioFixtureRoot 'upsert-observations')) -and [IO.File]::ReadAllText((Join-Path $ioFixtureRoot 'upsert-capture-status.txt')).Trim() -eq $ioStage) ('consumed publication IO failure has fixed evidence without revival sample or overwritten status: '+$publicationRoute)
    }
} finally { $fields['root'].SetValue($null,$fixtureRoot.ToString()) }
# Two-phase native payload binding. Keep the original 216 assertions before
# this scene so the immutable 1.0.10 negative control fails on the reference
# timing defect itself, not a new field, version string or unrelated guard.
$phasePriorChecks = $checks.Count
$methods['Login'].Invoke($null,@($login.PSObject.BaseObject,$true)) | Out-Null
$nativeLifetimes.Clear()
$phaseFiles = Count-UpsertFiles
$sealField = $upsertObservationType.GetField('PayloadSealed')
Start-AnonymousTransport
$phaseQuery = $upsert.PSObject.BaseObject
$phaseObservation = $upsertObservations[$phaseQuery]
$phasePayload = $nativeRequestField.GetValue($phaseQuery).upsertUserAll
$phaseStarted = $phaseObservation.Started
$phaseGeneration = $phaseObservation.Generation
$phaseLifetime = $phaseObservation.Lifetime
$factoryUnsealed = $null -ne $sealField -and !$sealField.GetValue($phaseObservation)
$methods['UpsertUserAgent'].Invoke($null,@($phaseQuery,'ANONYMOUS-FIRST-SEAL-AGENT')) | Out-Null
$agentUnsealed = $null -ne $sealField -and !$sealField.GetValue($phaseObservation)
$nativePayloadType.GetField('userData').SetValue($phasePayload,[object[]]@(New-Object object))
$nativePayloadType.GetField('isNewMusicDetailList').SetValue($phasePayload,'1')
$methods['ReadUpsertRequest'].Invoke($null,@($phaseQuery,$serializedUpsert)) | Out-Null
$samePhaseQuery = [object]::ReferenceEquals($phaseQuery,$upsert.PSObject.BaseObject)
$samePhasePayload = [object]::ReferenceEquals($phasePayload,$nativeRequestField.GetValue($phaseQuery).upsertUserAll)
$phaseGetterAccepted = $upsertObservations.ContainsKey($phaseQuery) -and $phaseObservation.SerializedRequest -ceq $serializedUpsert
[ordered]@{ scene='same-query-same-payload-reference-prepared-before-first-original-getter'; priorChecks=$phasePriorChecks; sameQuery=$samePhaseQuery; samePayload=$samePhasePayload; pendingQueries=$upsertObservations.Count; sampleCountChanged=((Count-UpsertFiles)-ne$phaseFiles); firstGetterAccepted=$phaseGetterAccepted; reason=(Read-UpsertDiagnostic).lastReason; stage=(Read-UpsertStage); nativeCalls=($transportClientType.GetField('methodCalls').GetValue($null)+$nativePayloadType.GetField('serializerCalls').GetValue($null)) } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'phase-regression-observation.json') -Encoding UTF8
Assert-Capture ($samePhaseQuery -and $samePhasePayload -and $phaseGetterAccepted -and (Count-UpsertFiles)-eq$phaseFiles) 'first observed native getter accepts prepared top-level references on the same exact query and UserAll'
Assert-Capture ($factoryUnsealed -and $agentUnsealed -and $sealField.GetValue($phaseObservation) -and $phaseObservation.Started -eq $phaseStarted -and $phaseObservation.Generation -eq $phaseGeneration -and [object]::ReferenceEquals($phaseObservation.Lifetime,$phaseLifetime)) 'factory and agent never seal while first validated getter preserves the original owner generation and TTL'
$sealedFields = $phaseObservation.PayloadFields
$sealedValues = $phaseObservation.PayloadValues
$methods['ReadUpsertRequest'].Invoke($null,@($phaseQuery,$serializedUpsert.Replace('"nonce_":8','"nonce_":9'))) | Out-Null
Assert-Capture ([object]::ReferenceEquals($phaseObservation.PayloadFields,$sealedFields) -and [object]::ReferenceEquals($phaseObservation.PayloadValues,$sealedValues)) 'a later legitimate original request result cannot reseal the first payload snapshot'
Complete-AnonymousUpsert
Assert-Capture ((Count-UpsertFiles)-eq($phaseFiles+1) -and $upsertObservations.Count-eq0 -and $fields['upsertRequestBytes'].GetValue($null)-eq0) 'the exact getter-sealed query publishes its original accepted response once'

Start-AnonymousTransport
$phaseObservation = $upsertObservations[$upsert.PSObject.BaseObject]
$phasePayload = $nativeRequestField.GetValue($upsert.PSObject.BaseObject).upsertUserAll
$nativePayloadType.GetField('userData').SetValue($phasePayload,[object[]]@(New-Object object))
$nativePayloadType.GetField('userMusicDetailList').SetValue($phasePayload,[object[]]@(New-Object object))
$methods['UpsertUserAgent'].Invoke($null,@($upsert.PSObject.BaseObject,'ANONYMOUS-FIRST-SEAL-AGENT')) | Out-Null
Assert-Capture (!$sealField.GetValue($phaseObservation) -and $null-eq$phaseObservation.PayloadFields -and $null-eq$phaseObservation.PayloadValues) 'an exact client and an agent alone retain no top-level payload values before observed request evidence'
Send-AnonymousTransport
Assert-Capture ($sealField.GetValue($phaseObservation) -and $phaseObservation.TransportRequestObserved -and $phaseObservation.SerializedRequest-ceq$transportText) 'actual exact-client send can first seal when the optional getter was never observed'
Prepare-AnonymousResponse; Complete-AnonymousTransport
Assert-Capture ((Count-UpsertFiles)-eq($phaseFiles+2) -and $upsertObservations.Count-eq0) 'transport-first seal publishes only its exact successful decoded response'

Start-AnonymousTransport; Observe-AnonymousUpsert
$phaseObservation = $upsertObservations[$upsert.PSObject.BaseObject]
$sealedFields = $phaseObservation.PayloadFields; $sealedValues = $phaseObservation.PayloadValues
Send-AnonymousTransport
Assert-Capture ($phaseObservation.SerializedRequest-ceq$transportText -and $phaseObservation.Agent-ceq'ANONYMOUS-ACTUAL-TRANSPORT-AGENT' -and [object]::ReferenceEquals($phaseObservation.PayloadFields,$sealedFields) -and [object]::ReferenceEquals($phaseObservation.PayloadValues,$sealedValues)) 'actual send bytes become authoritative without replacing an already getter-sealed payload snapshot'
Prepare-AnonymousResponse; Complete-AnonymousTransport
Assert-Capture ((Count-UpsertFiles)-eq($phaseFiles+3) -and $upsertObservations.Count-eq0) 'both request observation routes share one publication and consumed lifetime'

foreach ($firstBoundary in @('owner-user','owner-card','owner-client','request-region','request-place','request-payload-reference','source-generation','source-machine','source-identity','lifetime-expired','legacy-request-budget','legacy-request-character-limit','legacy-request-utf8-limit')) {
    Start-AnonymousTransport
    $phaseObservation = $upsertObservations[$upsert.PSObject.BaseObject]
    $savedIdentity = $fields['loginIdentity'].GetValue($null); $savedMachine = $fields['machineSnapshot'].GetValue($null); $savedGeneration = $fields['loginGeneration'].GetValue($null)
    switch ($firstBoundary) {
        'owner-user' { Set-NativeUpsertField 'userId' ([long]43) }
        'owner-card' { Set-NativeUpsertField 'accessCode' '10000000000000000002' }
        'owner-client' { Set-NativeUpsertField 'clientId' 'A1234567891' }
        'request-region' { Set-NativeUpsertField 'regionId' ([int]2) }
        'request-place' { Set-NativeUpsertField 'placeId' ([uint32]4) }
        'request-payload-reference' { Set-NativeUpsertField 'upsertUserAll' ([Activator]::CreateInstance($nativePayloadType)) }
        'source-generation' { $fields['loginGeneration'].SetValue($null,'anonymous-changed-generation') }
        'source-machine' { $fields['machineSnapshot'].SetValue($null,'{}') }
        'source-identity' { $fields['loginIdentity'].SetValue($null,'{}') }
        'lifetime-expired' { $oldTime=[DateTime]::UtcNow.AddMinutes(-3); $upsertObservationType.GetField('Started').SetValue($phaseObservation,$oldTime); $phaseObservation.Lifetime.GetType().GetField('Started').SetValue($phaseObservation.Lifetime,$oldTime) }
        'legacy-request-budget' { $fields['upsertRequestBytes'].SetValue($null,[int](16*1024*1024)) }
    }
    $body = if ($firstBoundary-eq'legacy-request-character-limit') {'x'*(8*1024*1024+1)} elseif ($firstBoundary-eq'legacy-request-utf8-limit') {([string][char]0x754c)*2800000} else {$serializedUpsert}
    $methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,$body)) | Out-Null
    if ($firstBoundary-eq'legacy-request-budget') { $fields['upsertRequestBytes'].SetValue($null,[int]0) }
    Assert-Capture (!$sealField.GetValue($phaseObservation) -and $null-eq$phaseObservation.PayloadFields -and $null-eq$phaseObservation.PayloadValues -and (Read-UpsertDiagnostic).lastReason-eq$firstBoundary -and $phaseObservation.Lifetime.Retired -and $upsertObservations.Count-eq0 -and $fields['upsertRequestBytes'].GetValue($null)-eq0 -and (Count-UpsertFiles)-eq($phaseFiles+3)) ('strong owner source and first lifetime bounds are enforced before sealing: '+$firstBoundary)
    $fields['loginIdentity'].SetValue($null,$savedIdentity); $fields['machineSnapshot'].SetValue($null,$savedMachine); $fields['loginGeneration'].SetValue($null,$savedGeneration)
}
$badPhaseRequests = @(
    @{ body=$serializedUpsert.Replace('"userId":42','"userId":43'); reason='owner-user' },
    @{ body=$serializedUpsert.Replace('"userId":42','"userId":"42"'); reason='owner-user' },
    @{ body=$serializedUpsert.Replace('"userId":42','"userId":42,"userId":42'); reason='json-invalid' },
    @{ body=$serializedUpsert.Replace('"accessCode":"10000000000000000001"','"accessCode":"10000000000000000002"'); reason='owner-card' },
    @{ body=$serializedUpsert.Replace('"accessCode":"10000000000000000001",',''); reason='owner-card' },
    @{ body=$serializedUpsert.Replace('"clientId":"A1234567890"','"clientId":"A1234567891"'); reason='owner-client' },
    @{ body=$serializedUpsert.Replace('"regionId":1','"regionId":2'); reason='region' },
    @{ body=$serializedUpsert.Replace('"regionId":1','"regionId":1.0'); reason='region' },
    @{ body=$serializedUpsert.Replace('"placeId":3','"placeId":-3'); reason='place' },
    @{ body='{"userId":42,"accessCode":"10000000000000000001","clientId":"A1234567890","regionId":1,"placeId":3,"upsertUserAll":[]}'; reason='payload-missing' },
    @{ body=$serializedUpsert+' trailing'; reason='json-invalid' }
)
foreach ($route in @('legacy','transport')) {
    foreach ($bad in $badPhaseRequests) {
        Start-AnonymousTransport
        $phaseObservation = $upsertObservations[$upsert.PSObject.BaseObject]
        if ($route-eq'legacy') { $methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,$bad.body)) | Out-Null }
        else { Send-AnonymousTransport ([Text.Encoding]::UTF8.GetBytes($bad.body)) }
        $reason = $route+'-request-'+$bad.reason
        $unsealedRejection = !$sealField.GetValue($phaseObservation) -and $null-eq$phaseObservation.PayloadFields -and $null-eq$phaseObservation.PayloadValues
        $methods['ReadUpsertRequest'].Invoke($null,@($upsert.PSObject.BaseObject,$serializedUpsert)) | Out-Null
        Send-AnonymousTransport; Prepare-AnonymousResponse; Complete-AnonymousTransport; Complete-AnonymousUpsert
        Assert-Capture ($unsealedRejection -and (Read-UpsertDiagnostic).lastReason-eq$reason -and $phaseObservation.Lifetime.Retired -and $upsertObservations.Count-eq0 -and $fields['upsertRequestBytes'].GetValue($null)-eq0 -and (Count-UpsertFiles)-eq($phaseFiles+3)) ('invalid first '+$route+' body cannot seal or restore retired ownership: '+$bad.reason)
    }
}
foreach ($route in @('legacy','transport')) {
    foreach ($mutation in @('userData','userMusicDetailList','isNewMusicDetailList')) {
        Start-AnonymousTransport
        if ($route-eq'legacy') { Observe-AnonymousUpsert } else { Send-AnonymousTransport }
        $phaseObservation = $upsertObservations[$upsert.PSObject.BaseObject]
        $phasePayload = $nativeRequestField.GetValue($upsert.PSObject.BaseObject).upsertUserAll
        if ($mutation-eq'isNewMusicDetailList') { $nativePayloadType.GetField($mutation).SetValue($phasePayload,'1') }
        else { $nativePayloadType.GetField($mutation).SetValue($phasePayload,[object[]]@(New-Object object)) }
        $expectedReason = if ($mutation-eq'isNewMusicDetailList') {'request-payload-marker'} else {'request-payload-field-reference'}
        if ($route-eq'legacy') { Complete-AnonymousUpsert } else { Prepare-AnonymousResponse; Complete-AnonymousTransport }
        Assert-Capture ($sealField.GetValue($phaseObservation) -and (Read-UpsertDiagnostic).lastReason-eq$expectedReason -and $upsertObservations.Count-eq0 -and $fields['upsertRequestBytes'].GetValue($null)-eq0 -and (Count-UpsertFiles)-eq($phaseFiles+3)) ('sealed '+$route+' snapshot rejects subsequent top-level replacement: '+$mutation)
    }
}
Start-AnonymousTransport; Send-AnonymousTransport
$phaseObservation = $upsertObservations[$upsert.PSObject.BaseObject]
$sealedFields = $phaseObservation.PayloadFields; $sealedValues = $phaseObservation.PayloadValues
$phaseStarted = $phaseObservation.Started; $phaseGeneration = $phaseObservation.Generation; $phaseLifetime = $phaseObservation.Lifetime
$resetArguments = [object[]]@([Activator]::CreateInstance($transportPacketType,[object[]]@($upsert.PSObject.BaseObject)),$null)
$methods['BeginUpsertReset'].Invoke($null,$resetArguments) | Out-Null
$phaseRetryClient = [Activator]::CreateInstance($transportClientType)
try { $methods['CreatedUpsertClient'].Invoke($null,[object[]]@($phaseRetryClient,$factoryArgs)) | Out-Null }
finally { $methods['EndUpsertReset'].Invoke($null,@($resetArguments[1])) | Out-Null }
Assert-Capture ($sealField.GetValue($phaseObservation) -and [object]::ReferenceEquals($phaseObservation.PayloadFields,$sealedFields) -and [object]::ReferenceEquals($phaseObservation.PayloadValues,$sealedValues) -and $phaseObservation.Started-eq$phaseStarted -and $phaseObservation.Generation-eq$phaseGeneration -and [object]::ReferenceEquals($phaseObservation.Lifetime,$phaseLifetime) -and !$phaseObservation.TransportRequestObserved) 'an exact reset clears send bytes while retaining the seal and the first generation lifetime'
$phasePayload = $nativeRequestField.GetValue($upsert.PSObject.BaseObject).upsertUserAll
$nativePayloadType.GetField('userData').SetValue($phasePayload,[object[]]@(New-Object object))
$script:transportClient = $phaseRetryClient
Send-AnonymousTransport; Prepare-AnonymousResponse; Complete-AnonymousTransport
Assert-Capture ((Read-UpsertDiagnostic).lastReason-eq'request-payload-field-reference' -and $upsertObservations.Count-eq0 -and (Count-UpsertFiles)-eq($phaseFiles+3)) 'a retry cannot reseal a replaced payload or publish the former successful send'
Assert-Capture ($transportClientType.GetField('methodCalls').GetValue($null)-eq0 -and $nativePayloadType.GetField('serializerCalls').GetValue($null)-eq0) 'all two-phase observation routes leave fake original getters serializers factories sends resets and completions uncalled'
$pluginHasher = [Security.Cryptography.SHA256]::Create()
try { $pluginHash = [BitConverter]::ToString($pluginHasher.ComputeHash([IO.File]::ReadAllBytes($plugin))).Replace('-', '').ToLowerInvariant() } finally { $pluginHasher.Dispose() }
$report = @{ passed=$true; checks=@($checks.ToArray()); priorChecks=$priorChecks; diagnosticChecks=($phasePriorChecks-$priorChecks); phasePriorChecks=$phasePriorChecks; phaseChecks=($checks.Count-$phasePriorChecks); pluginSha256=$pluginHash; gameExecuted=$false; serverRequests=0 }
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'plugin-result.json') -Encoding UTF8
Write-Output ("Passed {0} capture ownership checks on compiled plugin; no game launched." -f $checks.Count)
