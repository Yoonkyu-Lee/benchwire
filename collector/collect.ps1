# 현재 장치 트리·링크·화면·배터리를 읽어 로컬 JSON으로 지정한 곳에 저장한다. Add-Type은 컴파일용 임시 파일을 쓴다.
[CmdletBinding()]
param([string]$Out = (Join-Path $env:TEMP 'benchwire-collect.json'))

$ErrorActionPreference = 'Stop'
if ($Out -notmatch '^[A-Za-z]:[\\/][^:]*\.json$') { throw '로컬 드라이브의 절대 .json 경로를 지정하세요.' }
$Out = [IO.Path]::GetFullPath($Out)
$root = [IO.Path]::GetPathRoot($Out)
$drive = [IO.DriveInfo]::new($root)
if ($drive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable, [IO.DriveType]::Ram)) {
    throw '로컬 드라이브의 .json 경로를 지정하세요.'
}
# 연결을 따라가면 로컬 드라이브의 이름으로 원격 경로에 쓸 수 있다.
$entry = $root
foreach ($part in $Out.Substring($root.Length).Split('\')) {
    $entry = [IO.Path]::Combine($entry, $part)
    try { $attributes = [IO.File]::GetAttributes($entry) }
    catch [IO.FileNotFoundException] {
        if ($entry -eq $Out) { break }
        throw
    }
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw '링크를 거치지 않는 로컬 .json 경로를 지정하세요.' }
}
$capturedAt = Get-Date -Format o
$devices = @{}
$readings = @()
function Reading($device, $kind, $value, $unit, $reason, $medium) {
    $row = [ordered]@{ device = $device; kind = $kind; value = $value; unit = $unit }
    if ($null -eq $value) { $row.reason = if ($reason) { [string]$reason } else { 'Windows가 값을 제공하지 않았습니다.' } }
    if ($medium) { $row.medium = $medium }
    $script:readings += $row
}
function KnownDevice($id) {
    if ($id -and $devices.ContainsKey($id)) { return $devices[$id].id }
}
$nativeError = $null
try {
    if (-not ('BenchwireRead' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class BenchwireRead {
    // Windows SDK usbioctl.h · usbiodef.h: 현재 연결 상태를 읽는 질의만 사용한다.
    [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)]
    static extern int CM_Get_Device_Interface_List_SizeW(out uint chars, ref Guid type, string device, uint flags);
    [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)]
    static extern int CM_Get_Device_Interface_ListW(ref Guid type, string device, [Out] char[] paths, uint chars, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeviceIoControl(SafeFileHandle hub, uint code, byte[] input, int size, [Out] byte[] output, int capacity, out int returned, IntPtr async);
    static byte[] HubInfo(SafeFileHandle hub, int function, int port, int size, bool usb3) {
        byte[] request = new byte[size], answer = new byte[size];
        BitConverter.GetBytes(port).CopyTo(request,0);
        if (function != 274) BitConverter.GetBytes(size).CopyTo(request,4);
        if (usb3) request[8] = 4;
        int returned;
        if (!DeviceIoControl(hub,(uint)((0x22 << 16) | (function << 2)),request,size,answer,size,out returned,IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (returned < (function == 274 ? 35 : size)) throw new InvalidOperationException("USB 응답 길이 부족");
        return answer;
    }
    static double LaneRate(uint speed) {
        return (speed >> 16) * Math.Pow(1000,(speed >> 4) & 3);
    }
    public static string UsbMode(string parent,int port) {
        var type = new Guid("f18a0e88-c30c-11d0-8815-00a0c906bed8");
        uint chars;
        if (CM_Get_Device_Interface_List_SizeW(out chars,ref type,parent,0)!=0 || chars<2)
            throw new InvalidOperationException("현재 부모 허브의 장치 인터페이스 없음");
        var paths = new char[chars];
        if (CM_Get_Device_Interface_ListW(ref type,parent,paths,chars,0)!=0)
            throw new InvalidOperationException("부모 허브 경로 조회 실패");
        using (var hub=CreateFileW(new string(paths).Split('\0')[0],0,3,IntPtr.Zero,3,0,IntPtr.Zero)) {
            if (hub.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            var ex=HubInfo(hub,274,port,4096,false);
            if (BitConverter.ToUInt32(ex,31)!=1) throw new InvalidOperationException("현재 연결된 USB 장치 없음");
            var v2=HubInfo(hub,279,port,16,true);
            uint flags=BitConverter.ToUInt32(v2,12);
            if ((flags & 4)!=0) {
                var plus=HubInfo(hub,289,port,24,false);
                double rx=LaneRate(BitConverter.ToUInt32(plus,8)), tx=LaneRate(BitConverter.ToUInt32(plus,16));
                uint lanes=BitConverter.ToUInt32(plus,12)+1;
                if (rx!=tx || lanes!=BitConverter.ToUInt32(plus,20)+1 || (lanes!=1 && lanes!=2) || (rx!=5e9 && rx!=10e9))
                    throw new InvalidOperationException("비대칭 또는 미지원 USB 레인 조합");
                return "Gen "+(rx==5e9?"1":"2")+"x"+lanes;
            }
            if ((flags & 1)!=0) return "Gen 1x1";
            if (ex[23]==2) return "High Speed";
            if (ex[23]==1) return "Full Speed";
            if (ex[23]==0) return "Low Speed";
            throw new InvalidOperationException("현재 USB 협상 모드 미확인");
        }
    }

    // wingdi.h: QDC_ONLY_ACTIVE_PATHS로 현재 신호의 해상도와 주사율을 읽는다.
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint low; public int high; }
    [StructLayout(LayoutKind.Sequential)] struct Ratio { public uint n,d; }
    [StructLayout(LayoutKind.Sequential)] struct Source { public Luid gpu; public uint id,mode,status; }
    [StructLayout(LayoutKind.Sequential)] struct Target {
        public Luid gpu; public uint id,mode,technology,rotation,scaling; public Ratio refresh; public uint scan,available,status;
    }
    [StructLayout(LayoutKind.Sequential)] struct DisplayPath { public Source source; public Target target; public uint flags; }
    [StructLayout(LayoutKind.Explicit,Size=64)] struct Mode {
        [FieldOffset(0)] public uint type;
        [FieldOffset(32)] public Ratio verticalSync;
        [FieldOffset(40)] public uint activeWidth;
        [FieldOffset(44)] public uint activeHeight;
    }
    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags,out uint paths,out uint modes);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags,ref uint paths,[Out] DisplayPath[] p,ref uint modes,[Out] Mode[] m,IntPtr topology);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr header);
    static byte[] DisplayInfo(int type,Luid gpu,uint id,int size) {
        var b = new byte[size]; var ptr=Marshal.AllocHGlobal(size);
        try {
            BitConverter.GetBytes(type).CopyTo(b,0); BitConverter.GetBytes(size).CopyTo(b,4);
            BitConverter.GetBytes(gpu.low).CopyTo(b,8); BitConverter.GetBytes(gpu.high).CopyTo(b,12); BitConverter.GetBytes(id).CopyTo(b,16);
            Marshal.Copy(b,0,ptr,size); int status=DisplayConfigGetDeviceInfo(ptr);
            if(status!=0) throw new Win32Exception(status);
            Marshal.Copy(ptr,b,0,size); return b;
        } finally { Marshal.FreeHGlobal(ptr); }
    }
    static string DeviceId(byte[] data,int offset,int chars) {
        string path=Encoding.Unicode.GetString(data,offset,chars*2).TrimEnd('\0');
        if (!path.StartsWith(@"\\?\")) return null;
        string[] ids=path.Substring(4).Split('#');
        return ids.Length<3 ? null : (ids[0]+"\\"+ids[1]+"\\"+ids[2]).ToUpperInvariant();
    }
    public class Screen {
        public string Device, Mode, Gpu, Connector, NameError, GpuError, DepthError;
        public int Bits;
    }
    public static Screen[] Displays() {
        uint n,m; int e=GetDisplayConfigBufferSizes(2,out n,out m);
        if(e!=0) throw new Win32Exception(e);
        var paths=new DisplayPath[n]; var modes=new Mode[m];
        e=QueryDisplayConfig(2,ref n,paths,ref m,modes,IntPtr.Zero);
        if(e!=0) throw new Win32Exception(e);
        var screens=new Screen[n];
        for(int i=0;i<n;i++) {
            var t=paths[i].target; var s=new Screen(); screens[i]=s;
            if(t.mode<m && modes[t.mode].type==2) {
                var signal=modes[t.mode]; var rate=t.refresh.d==0 ? signal.verticalSync : t.refresh;
                if(rate.d!=0 && rate.n!=0 && signal.activeWidth>0 && signal.activeHeight>0)
                    s.Mode=String.Format(System.Globalization.CultureInfo.InvariantCulture,"{0}×{1}@{2:0.###}",signal.activeWidth,signal.activeHeight,(double)rate.n/rate.d);
            }
            // DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY의 열거값을 보존한다.
            string[] technologies={"VGA","S-Video","Composite","Component","DVI","HDMI","LVDS",null,"D-JPN","SDI","DisplayPort","내장 DisplayPort","UDI","내장 UDI","SDTV","Miracast","간접 유선","간접 가상","USB DisplayPort"};
            s.Connector=t.technology<technologies.Length && technologies[t.technology]!=null ? technologies[t.technology] : "Windows "+t.technology;
            try { s.Device=DeviceId(DisplayInfo(2,t.gpu,t.id,420),164,128); } catch(Win32Exception ex) { s.NameError=ex.Message; }
            try { s.Gpu=DeviceId(DisplayInfo(4,t.gpu,0,276),20,128); } catch(Win32Exception ex) { s.GpuError=ex.Message; }
            try { s.Bits=BitConverter.ToInt32(DisplayInfo(9,t.gpu,t.id,32),28); } catch(Win32Exception ex) { s.DepthError=ex.Message; }
        }
        return screens;
    }
}
'@
    }
} catch { $nativeError = 'Add-Type 사용 불가: ' + $_.Exception.Message }

try { $present = @(Get-PnpDevice -PresentOnly) }
catch { $present = @(); Reading $null 'tree' $null '' $_.Exception.Message }
foreach ($dev in $present) {
    $id = $dev.InstanceId
    $properties = @{}
    try {
        foreach ($p in (Get-PnpDeviceProperty -InstanceId $id)) {
            if ($null -ne $p.Data -and $p.Type -ne 'Empty' -and $p.Type -ne 'Error') { $properties[$p.KeyName] = $p.Data }
        }
    } catch { Reading $id 'tree' $null '' $_.Exception.Message }
    $name = if ($dev.FriendlyName) { $dev.FriendlyName } elseif ($properties.DEVPKEY_Device_DeviceDesc) { $properties.DEVPKEY_Device_DeviceDesc } else { $id }
    $devices[$id] = [ordered]@{ id=$id; name=[string]$name; parent=$properties.DEVPKEY_Device_Parent
        children=@(); locations=@($properties.DEVPKEY_Device_LocationPaths | Where-Object { $_ })
        hardwareIds=@($properties.DEVPKEY_Device_HardwareIds | Where-Object { $_ }); driver=$properties.DEVPKEY_Device_DriverVersion }
    $missing = @('Parent','LocationPaths','HardwareIds','DriverVersion' | Where-Object { !$properties["DEVPKEY_Device_$_"] })
    if ($missing.Count) { Reading $id 'tree' $null '' ('제공되지 않은 장치 속성: ' + ($missing -join ', ')) }
    if ($id -like 'PCI\*') {
        foreach ($field in @(
            @{ key='DEVPKEY_PciDevice_CurrentLinkSpeed'; kind='pcieGeneration'; unit='' }
            @{ key='DEVPKEY_PciDevice_CurrentLinkWidth'; kind='pcieWidth'; unit='lanes' }
        )) {
            try {
                $v = (Get-PnpDeviceProperty -InstanceId $id -KeyName $field.key).Data
                if ($null -eq $v -or [int]$v -le 0) { throw '현재 PCIe 링크 값이 없습니다.' }
                Reading $id $field.kind ([int]$v) $field.unit
            } catch { Reading $id $field.kind $null $field.unit $_.Exception.Message }
        }
    }
}
foreach ($d in $devices.Values) {
    $parent = KnownDevice $d.parent
    if ($parent) { $devices[$parent].children += $d.id }
    if ($d.id -notlike 'USB\*' -or $d.id -like 'USB\ROOT_HUB*' -or $d.id -match '&MI_[0-9A-F]{2}\\') { continue }
    if (!$parent) { Reading $d.id 'usbMode' $null '' '부모 허브를 찾을 수 없습니다.'; continue }
    $location = $d.locations | Where-Object { $_ -match '#USB\(\d+\)$' } | Select-Object -First 1
    if (!$location -or $location -notmatch '#USB\((\d+)\)$') {
        Reading $d.id 'usbMode' $null '' '부모 허브의 포트 번호를 확인할 수 없습니다.'; continue
    }
    $port = [int]$Matches[1]
    Reading $d.id 'usbParent' $parent ''
    try {
        if ($nativeError) { throw $nativeError }
        Reading $d.id 'usbMode' ([BenchwireRead]::UsbMode($parent,$port)) ''
    } catch { Reading $d.id 'usbMode' $null '' $_.Exception.Message }
}
try {
    $adapters = @(Get-NetAdapter -Physical)
    if (!$adapters.Count) { Reading $null 'linkSpeed' $null 'Mbps' '물리 네트워크 어댑터가 없습니다.' }
    foreach ($nic in $adapters) {
        $id = KnownDevice $nic.PnPDeviceID
        if ($nic.Status -ne 'Up') { Reading $id 'linkSpeed' $null 'Mbps' '연결되지 않은 어댑터'; continue }
        if (!$nic.ReceiveLinkSpeed -or $nic.ReceiveLinkSpeed -ne $nic.TransmitLinkSpeed) {
            Reading $id 'linkSpeed' $null 'Mbps' '양방향의 같은 현재 회선 속도를 확인할 수 없습니다.'; continue
        }
        $medium = if ($nic.InterfaceType -eq 6) { '802.3' }
        Reading $id 'linkSpeed' ([double]$nic.ReceiveLinkSpeed / 1000000) 'Mbps' $null $medium
    }
} catch { Reading $null 'linkSpeed' $null 'Mbps' $_.Exception.Message }

try {
    if ($nativeError) { throw $nativeError }
    $screens = @([BenchwireRead]::Displays())
    if (!$screens.Count) { throw '활성 화면 경로가 없습니다.' }
    foreach ($s in $screens) {
        $id = KnownDevice $s.Device
        Reading $id 'displayMode' $s.Mode '' $s.NameError
        Reading $id 'connector' $s.Connector ''
        Reading $id 'outputGpu' $s.Gpu '' $s.GpuError
        if ($s.Bits -gt 0) { Reading $id 'bitDepth' $s.Bits 'bpc' }
        else { Reading $id 'bitDepth' $null 'bpc' $s.DepthError }
    }
} catch {
    foreach ($kind in 'displayMode','connector','outputGpu','bitDepth') {
        $unit = if ($kind -eq 'bitDepth') { 'bpc' } else { '' }
        Reading $null $kind $null $unit $_.Exception.Message
    }
}
try {
    $monitors = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorDescriptorMethods)
    if (!$monitors.Count) { throw 'EDID를 제공한 화면이 없습니다.' }
    foreach ($monitor in $monitors) {
        $id = KnownDevice ($monitor.InstanceName -replace '_\d+$','')
        try {
            $hex = ''; $blocks = 1
            for ($i=0; $i -lt $blocks; $i++) {
                $block = Invoke-CimMethod -InputObject $monitor -MethodName WmiGetMonitorRawEEdidV1Block -Arguments @{BlockId=[byte]$i}
                if ($block.BlockContent.Count -ne 128) { throw 'EDID 블록 길이가 다릅니다.' }
                if ($i -eq 0) { $blocks = 1 + [int]$block.BlockContent[126] }
                $hex += -join ($block.BlockContent | ForEach-Object { '{0:X2}' -f $_ })
            }
            Reading $id 'edid' $hex ''
        } catch { Reading $id 'edid' $null '' $_.Exception.Message }
    }
} catch { Reading $null 'edid' $null '' $_.Exception.Message }

try {
    $batteries = @(Get-CimInstance -ClassName Win32_Battery)
    if (!$batteries.Count) { throw '배터리가 없습니다.' }
    try {
        $rate = [Windows.Devices.Power.Battery,Windows.Devices.Power,ContentType=WindowsRuntime]::AggregateBattery.GetReport().ChargeRateInMilliwatts
        if ($null -eq $rate) { throw 'WinRT 충방전율 미제공' }
        Reading $null 'batteryRate' ([double]$rate / 1000) 'W'
    } catch {
        $status = @(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus)
        if (!$status.Count) { throw 'WinRT와 WMI 모두 배터리 충방전율을 제공하지 않았습니다.' }
        foreach ($b in $status) {
            $id = KnownDevice ($b.InstanceName -replace '_\d+$','')
            $rate = if ($b.Charging) { $b.ChargeRate } elseif ($b.Discharging) { $b.DischargeRate }
            if ($null -eq $rate -or $rate -eq 4294967295) { Reading $id 'batteryRate' $null 'W' '배터리 드라이버가 충방전율을 제공하지 않았습니다.'; continue }
            $sign = if ($b.Discharging) { -1 } else { 1 }
            Reading $id 'batteryRate' ($sign * [double]$rate / 1000) 'W'
        }
    }
} catch { Reading $null 'batteryRate' $null 'W' $_.Exception.Message }

try { $build = (Get-CimInstance -ClassName Win32_OperatingSystem).BuildNumber }
catch { $build = '미확인' }
[ordered]@{ version=1; capturedAt=$capturedAt; osBuild=[string]$build; devices=@($devices.Values | Sort-Object { $_.id }); readings=$readings } |
    ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 -LiteralPath $Out
