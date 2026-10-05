param([Parameter(Mandatory=$true)][string]$GameRoot, [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
trap { Write-Output $_.Exception.ToString(); Write-Output $_.ScriptStackTrace; exit 1 }
$projectRoot = Split-Path $PSScriptRoot -Parent
$core = Join-Path $projectRoot 'resources/hdd-setup/mod/BepInEx/core'
foreach ($file in @((Join-Path $GameRoot 'mu3_Data/Managed/UnityEngine.dll'), (Join-Path $core '0Harmony20.dll'), (Join-Path $core 'BepInEx.dll'))) { [Reflection.Assembly]::LoadFrom($file) | Out-Null }
$assembly = [Reflection.Assembly]::LoadFrom((Join-Path $projectRoot 'resources/player-capture/OGKToolBox.PlayerCapture.dll'))
$type = $assembly.GetType('PlayerCapture', $true)
$flags = [Reflection.BindingFlags]'NonPublic,Static'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public enum EditDifficulty { Basic, Advanced, Expert, Master, Lunatic }
public class EditDetail {
 public int Money {get;private set;} public int AlmightySphereCount {get;private set;} public int MedalCount {get;private set;} public int SizukuCount {get;private set;}
 public void AddMoney(int n){Money+=n;} public void SubMoney(int n){Money-=n;}
 public void AddAlmightySphereCount(int n){AlmightySphereCount+=n;} public void SubAlmightySphereCount(int n){AlmightySphereCount-=n;}
 public void AddMedalCount(int n){MedalCount+=n;} public void SubMedalCount(int n){MedalCount-=n;}
 public void AddSizukuCount(int n){SizukuCount+=n;} public void SubSizukuCount(int n){SizukuCount-=n;}
}
public class EditItem { public bool IsNew {get;set;} public int Num {get;private set;} public bool Modified; public void addCount(int n){Num+=n;Modified=true;} public void subCount(int n){Num-=n;Modified=true;} }
public class EditChapter {public int SphereCount{get;private set;} public int JewelCount{get;private set;} public bool Modified; public void AddJewelCount(int n){SphereCount+=n;JewelCount+=n;Modified=true;} public void SubSphereCount(int n){SphereCount-=n;Modified=true;} public void SubJewelCount(int n){JewelCount-=n;Modified=true;} }
public class EditFumen {
 public int PlayCount {get;private set;}
 public int TechScoreMaxRaw{get;set;} public int TechScoreMax{get{return Math.Min(TechScoreMaxRaw,1010000);}} public int TechScoreRank{get;set;}
 public int PlatinumScoreMax{get;set;} public int PlatinumScoreRank{get;set;} public int PlatinumScorePercent{get;set;} public int BattleScoreMax{get;set;}
 public bool IsFullCombo{get;set;} public bool IsFullBell{get;set;} public bool IsAllBreak{get;set;} public bool IsClear{get;set;}
 public int MaxComboCount{get;set;} public int OverDamageMaxX100{get;set;} public int TeamOverDamageMaxX100{get;set;} public int BattleScoreRank{get;set;}
 public bool IsNewOrModified{get{return true;}} public void AddPlayCount(int n){PlayCount+=n;}
}
public class EditBP {public int Calls;public void initBP(){Calls++;}}
public class EditManager {
 public long UserId {get;set;} public bool IsGuest {get;set;}
 public EditDetail userDetail{get;private set;} public EditBP userBattlePoint{get;private set;} public int RatingUpdates;
 public Dictionary<int,EditItem> Items=new Dictionary<int,EditItem>(); public Dictionary<int,EditChapter> Chapters=new Dictionary<int,EditChapter>(); public EditFumen Fumen=new EditFumen();
 public EditManager(){userDetail=new EditDetail();userBattlePoint=new EditBP();Fumen.PlatinumScoreMax=1900;Fumen.TechScoreMaxRaw=900000;Fumen.AddPlayCount(4);}
 public EditItem getUserGachaTicket(int id,bool create){if(!Items.ContainsKey(id)&&create)Items[id]=new EditItem{IsNew=true};return Items.ContainsKey(id)?Items[id]:null;}
 public EditItem getUserKaikaItem(int id,bool create){return getUserGachaTicket(id,create);} public EditItem getUserExpUpItem(int id,bool create){return getUserGachaTicket(id,create);} public EditItem getUserIntimateUpItem(int id,bool create){return getUserGachaTicket(id,create);} public EditItem getUserUnlockItem(int id,bool create){return getUserGachaTicket(id,create);}
 public EditChapter getUserChapter(int id,bool create){if(!Chapters.ContainsKey(id)&&create)Chapters[id]=new EditChapter();return Chapters.ContainsKey(id)?Chapters[id]:null;}
 public EditChapter getUserStory(int id,bool create){return getUserChapter(id,create);}
 public EditFumen getUserFumen(int musicId,EditDifficulty diff,bool create){return Fumen;}
 public void updateUserRating(){RatingUpdates++;}public void updateUserNewRating(){RatingUpdates++;}public void updateTotalHiScore(){RatingUpdates++;}
}
namespace MU3.Data {
 public class EditAnalysis { public int platinumScoreMax=2000; }
 public class EditGameData {public int calcTechnicalRank(int score){return score>=1007500?12:10;} public int GetPlatinumScoreRank(int score,int maximum){return score*1000/maximum>=990?6:0;} public int GetPlatinumScorePercent(int score,int maximum){return score*1000/maximum;}}
 public class DataManager {static DataManager current=new DataManager();public static DataManager instance{get{return current;}} public EditGameData gameData{get;private set;} public DataManager(){gameData=new EditGameData();}public EditAnalysis getFumenAnalysisData(int musicId,EditDifficulty level){return new EditAnalysis();}}
}
public class EditWireAll {public object[] userData,userItemList,userChapterList,userStoryList,userMusicDetailList;}
public class EditWireItem {public int itemKind,itemId;}
public class EditWireChapter {public int chapterId;}
public class EditWireMusic {public int musicId,level;}
'@
$fixture = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ('fixture-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$type.GetField('root',$flags).SetValue($null,$fixture)
$type.GetField('session',$flags).SetValue($null,'anonymous-session')
$script:checks=0
function Check($value,[string]$label) { if (!$value) { throw $label }; $script:checks++; Write-Output ('PASS '+$label) }
function Make([string]$name) { return [Activator]::CreateInstance($type.GetNestedType($name,[Reflection.BindingFlags]'Public,NonPublic')) }
function Resource([string]$key,[int]$value) { $r=Make 'EditResource';$r.key=$key;$r.value=$value;return $r }
function Command { $c=Make 'EditCommand';$c.version=1;$c.id=[Guid]::NewGuid().ToString('N');$c.host='play.mumur.net';$c.accessCode='12345678901234567890';$c.clientId='A1234567890';$c.createdAt=[DateTime]::UtcNow.ToString('o');$c.resources=@();$c.scores=@();return $c }
function Apply($manager,$command) {
 $prefix=Join-Path $fixture $command.id;$file=$prefix+'.pending.json';[IO.File]::WriteAllText($file,'fixture');
 $type.GetMethod('ApplyEditCommand',$flags).Invoke($null,@($manager.psobject.BaseObject,$command,'fixture',[string]$file,[string]$prefix)) | Out-Null
 return $prefix
}
function Confirm($command,$all,[string]$session='anonymous-session') {
 $o=Make 'UpsertObservation';$o.GetType().GetField('Session').SetValue($o,$session);$o.GetType().GetField('Card').SetValue($o,$command.accessCode);$o.GetType().GetField('Client').SetValue($o,$command.clientId);$o.GetType().GetField('Started').SetValue($o,[DateTime]::UtcNow.AddSeconds(1));$o.GetType().GetField('UserAll').SetValue($o,$all.psobject.BaseObject)
 $type.GetMethod('ConfirmAppliedEdit',$flags).Invoke($null,@($o)) | Out-Null
}
$manager=New-Object EditManager;$job=Command
$job.resources=@((Resource 'data:point' 1000),(Resource 'item:11:1' 9),(Resource 'chapter:2' 50))
$score=Make 'EditScore';$score.musicId=101;$score.difficulty=3;$score.techScore=1008000;$score.platinumScore=1000;$score.platinumMax=2000;$score.fields=@('techScore');$job.scores=@($score)
$prefix=Apply $manager $job
Check ($manager.userDetail.Money -eq 1000 -and $manager.Items[1].Num -eq 9 -and $manager.Chapters[2].SphereCount -eq 50) 'resources change during the current session'
Check ($manager.Items[1].Modified -and $manager.Items[1].IsNew -and $manager.Chapters[2].Modified) 'native resource methods retain upload flags'
Check ($manager.Fumen.TechScoreMaxRaw -eq 1008000 -and $manager.Fumen.PlatinumScoreMax -eq 1900 -and $manager.Fumen.PlayCount -eq 4) 'score field mask preserves fresh unedited server values'
Check ($manager.RatingUpdates -eq 3 -and $manager.userBattlePoint.Calls -eq 1) 'native rating and battle-point caches refresh'
Check ((Test-Path ($prefix+'.active.json')) -and !(Test-Path ($prefix+'.pending.json'))) 'command claimed before mutation and stays active until accepted'
$manager.userDetail.AddMoney(25)
$wire=New-Object EditWireAll;$wire.userData=@((New-Object Object));Confirm $job $wire 'other-session'
Check ((Test-Path ($prefix+'.active.json'))) 'different session cannot acknowledge task'
Confirm $job $wire
Check ((Test-Path ($prefix+'.active.json'))) 'partial save cannot acknowledge unsent items and charts'
$item=[EditWireItem]::new();$item.itemKind=11;$item.itemId=1;$chapter=[EditWireChapter]::new();$chapter.chapterId=2;$music=[EditWireMusic]::new();$music.musicId=101;$music.level=3;$wire.userItemList=@($item);$wire.userChapterList=@($chapter);$wire.userMusicDetailList=@($music);Confirm $job $wire
Check ((Test-Path ($prefix+'.complete.json')) -and !(Test-Path ($prefix+'.active.json')) -and $manager.userDetail.Money -eq 1025) 'all accepted batches complete without resetting gameplay earnings'
$manager=New-Object EditManager;$job=Command;$job.resources=@((Resource 'data:point' 0));$prefix=Apply $manager $job
Check ((Test-Path ($prefix+'.complete.json'))) 'already-satisfied loaded target completes without waiting for a nonexistent dirty row'
$job=Command;$job.scores=@($score);$score.fields=@('platinumScore','playCount','maxComboCount','maxOverKill','maxTeamOverKill','battleScoreRank','clearStatus');$score.platinumScore=1980;$score.playCount=10;$score.maxComboCount=500;$score.maxOverKill=20000;$score.maxTeamOverKill=30000;$score.battleScoreRank=6;$score.clearStatus=1
$prefix=Apply $manager $job
Check ($manager.Fumen.PlatinumScoreRank -eq 6 -and $manager.Fumen.PlatinumScorePercent -eq 990) 'platinum rank and percent follow native metadata'
Check ($manager.Fumen.PlayCount -eq 10 -and $manager.Fumen.MaxComboCount -eq 500 -and $manager.Fumen.IsClear -and $manager.Fumen.BattleScoreRank -eq 6) 'additional score fields apply through native setters'
$job=Command;$job.resources=@((Resource 'data:point' 40));$prefix=Join-Path $fixture $job.id;$file=$prefix+'.pending.json';[IO.File]::WriteAllText($file,'replacement');$before=$manager.userDetail.Money;$failed=$false
try {$type.GetMethod('ApplyEditCommand',$flags).Invoke($null,@($manager.psobject.BaseObject,$job,'old-command',[string]$file,[string]$prefix)) | Out-Null} catch {$failed=$true}
Check ($failed -and $manager.userDetail.Money -eq $before -and (Test-Path ($prefix+'.active.json'))) 'cancel-and-replace race is detected before mutation and never replayed'
[IO.File]::WriteAllText($file,'old-command');$failed=$false
try {$type.GetMethod('ApplyEditCommand',$flags).Invoke($null,@($manager.psobject.BaseObject,$job,'old-command',[string]$file,[string]$prefix)) | Out-Null} catch {$failed=$true}
Check ($failed -and $manager.userDetail.Money -eq $before) 'existing active receipt blocks another application'
foreach($bad in @((Resource 'data:point' 1000000000),(Resource 'item:11:2' 100),(Resource 'item:99:1' 1),(Resource 'item:20:1' 0),(Resource 'story:1' -1))) {
 $job=Command;$job.resources=@($bad);$failed=$false;try{$type.GetMethod('PlanEdit',$flags).Invoke($null,@($manager.psobject.BaseObject,$job))|Out-Null}catch{$failed=$true};Check $failed ('invalid target rejected '+$bad.key)
}
$job=Command;$job.host='ea.naominet.live';$job.scores=@($score);$failed=$false;try{$type.GetMethod('PlanEdit',$flags).Invoke($null,@($manager.psobject.BaseObject,$job))|Out-Null}catch{$failed=$true};Check $failed 'native bridge also rejects non-MuNET score edits'
# Exercise the actual login entry and JSON/path/claim chain, not only an already
# decoded DTO. No Unity InternalCall or remote server is needed for task files.
function SetState([string]$name,$value) { $type.GetField($name,$flags).SetValue($null,$value) }
function Login($manager) { $type.GetMethod('ApplyEditsAfterLogin',$flags).Invoke($null,@($manager.psobject.BaseObject)) | Out-Null }
$entryRoot=Join-Path $fixture 'login-entry';[IO.Directory]::CreateDirectory((Join-Path $entryRoot 'edits'))|Out-Null
SetState 'root' $entryRoot;[IO.File]::WriteAllText((Join-Path $entryRoot 'capture.enabled'),'')
SetState 'editHooks' $true;SetState 'loginSaveAccepted' $true;SetState 'loginPlayer' '42';SetState 'loginGeneration' 'login-1'
SetState 'machineSnapshot' '{"dns":{"default":"play.mumur.net","AimeDB":"anonymous.invalid","replaceHost":"0"},"keychip":{"id":"anonymous"}}'
$job=Command;$job.resources=@((Resource 'data:medalCount' 40),(Resource 'data:shizukuCount' 50))
SetState 'loginCard' $job.accessCode;SetState 'loginClient' $job.clientId
$key=$type.GetMethod('EditKey',$flags).Invoke($null,@($job.host,$job.accessCode,$job.clientId))
$entryPrefix=Join-Path (Join-Path $entryRoot 'edits') $key
$json=$job | ConvertTo-Json -Depth 8 -Compress
[IO.File]::WriteAllText(($entryPrefix+'.pending.json'),$json)
$manager=New-Object EditManager;$manager.UserId=43;Login $manager
Check ((Test-Path ($entryPrefix+'.pending.json')) -and $manager.userDetail.MedalCount -eq 0) 'actual login entry rejects a mismatched runtime player'
$manager.UserId=42;Login $manager
Check ($manager.userDetail.MedalCount -eq 40 -and $manager.userDetail.SizukuCount -eq 50 -and (Test-Path ($entryPrefix+'.active.json'))) 'pending JSON applies medal and shizuku through actual login entry without toolbox or Unity serialization'
$manager.userDetail.AddMedalCount(5);Login $manager
Check ($manager.userDetail.MedalCount -eq 45) 'repeated same-login hook cannot reset earned resources'
SetState 'loginGeneration' 'login-2';Login $manager
Check ($manager.userDetail.MedalCount -eq 45 -and [IO.File]::ReadAllText((Join-Path $entryRoot 'edits-status.txt')) -eq 'needs-review') 'later login never replays an already-claimed task'
$decoded=$type.GetMethod('EditJson',$flags).Invoke($null,@([string]$json,$type.GetNestedType('EditCommand')))
Check ($decoded.resources.Length -eq 2 -and $decoded.resources[1].value -eq 50) 'managed decoder preserves complete command arrays and numeric targets'
foreach($invalid in @($json.Replace('"version":1','"version":1,"version":1'),$json.Replace('"value":40','"value":"40"'),$json.Replace('"value":40,','').Replace(',"value":40',''),($json+' false'),$json.Replace('"resources":[','"resources":[null,'))) {
 $failed=$false;try{$type.GetMethod('EditJson',$flags).Invoke($null,@([string]$invalid,$type.GetNestedType('EditCommand')))|Out-Null}catch{$failed=$true};Check $failed 'malformed or missing resource targets are rejected before claim'
}
SetState 'loginGeneration' 'login-3';SetState 'machineSnapshot' '{broken';Login $manager
$diagnostic=[IO.File]::ReadAllText((Join-Path $entryRoot 'edits-diagnostics.json'))|ConvertFrom-Json
Check ($diagnostic.stage -eq 'machine-json' -and $diagnostic.exception -eq 'FormatException' -and ($diagnostic.PSObject.Properties.Name -join ',') -eq 'stage,exception,at') 'pre-claim failure persists a private-data-free stage diagnostic'
@{checks=$script:checks;gameExecuted=$false;serverRequests=0;fixtureOnly=$true}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $OutputDirectory 'native-edits-result.json') -Encoding UTF8
Write-Output ('Native edit checks passed: '+$script:checks)
