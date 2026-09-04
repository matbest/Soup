# A tray switch for the Windows GPU watchdog.
#
# Windows resets the display driver if a single GPU dispatch takes longer than TdrDelay
# seconds — two, by default. Local language models run dispatches that are long by that
# standard, so a modest card gets reset in the middle of a run. Raising the limit is the
# usual fix for GPU compute on Windows.
#
# The cost is real and worth knowing: while a genuinely hung GPU is being waited on, the
# screen is frozen for that long before Windows recovers it. Ten seconds is the common
# recommendation. This never touches TdrLevel, which is what turns recovery off
# altogether and turns a hang into a reboot.
#
# Reading the setting needs no privileges. Changing it does, so each change asks for
# elevation, and takes effect at the next restart.
#
#   powershell -ExecutionPolicy Bypass -File tdr-tray.ps1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$KeyPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers'
$Raised = 10          # seconds, when switched on
$Default = 2          # what Windows uses when the value is absent

function Get-TdrDelay {
    $v = (Get-ItemProperty -Path $KeyPath -Name TdrDelay -ErrorAction SilentlyContinue).TdrDelay
    if ($null -eq $v) { return $null }
    return [int]$v
}

function Get-StatusText {
    $v = Get-TdrDelay
    if ($null -eq $v) { return "GPU watchdog: $Default seconds (Windows default)" }
    return "GPU watchdog: $v seconds"
}

# Both changes go through here, so there is one place that asks for elevation and one
# place that explains what happened.
function Set-TdrDelay([string]$command, [string]$done) {
    try {
        $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
             -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command
        if ($p.ExitCode -ne 0) { throw "the elevated step exited with $($p.ExitCode)" }
        $script:notify.BalloonTipTitle = $done
        $script:notify.BalloonTipText = 'Takes effect after a restart.'
    } catch {
        $script:notify.BalloonTipTitle = 'Nothing was changed'
        $script:notify.BalloonTipText = $_.Exception.Message
    }
    $script:notify.ShowBalloonTip(4000)
    Update-Menu
}

function Update-Menu {
    $v = Get-TdrDelay
    $script:notify.Text = Get-StatusText          # the tooltip, capped by Windows at 63 chars
    $script:status.Text = Get-StatusText
    $script:raise.Checked = ($v -eq $Raised)
    $script:restore.Checked = ($null -eq $v)
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Shield
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$status = New-Object System.Windows.Forms.ToolStripMenuItem
$status.Enabled = $false
[void]$menu.Items.Add($status)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$raise = New-Object System.Windows.Forms.ToolStripMenuItem
$raise.Text = "Give the GPU $Raised seconds"
$raise.ToolTipText = 'For running models locally. A real hang then freezes the screen for that long.'
$raise.Add_Click({
    Set-TdrDelay "New-ItemProperty -Path '$KeyPath' -Name TdrDelay -PropertyType DWord -Value $Raised -Force | Out-Null" `
                 "GPU watchdog set to $Raised seconds"
})
[void]$menu.Items.Add($raise)

$restore = New-Object System.Windows.Forms.ToolStripMenuItem
$restore.Text = "Back to the Windows default ($Default seconds)"
$restore.Add_Click({
    Set-TdrDelay "Remove-ItemProperty -Path '$KeyPath' -Name TdrDelay -ErrorAction SilentlyContinue" `
                 'GPU watchdog back to the Windows default'
})
[void]$menu.Items.Add($restore)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$about = New-Object System.Windows.Forms.ToolStripMenuItem
$about.Text = 'What is this?'
$about.Add_Click({
    [void][System.Windows.Forms.MessageBox]::Show(
        "Windows resets the display driver if one GPU dispatch takes longer than TdrDelay seconds. The default is $Default, which is short for a language model running on the graphics card, so a run gets cut off part way.`n`nRaising it to $Raised lets that work finish. The cost: if the GPU ever really does hang, the screen stays frozen for $Raised seconds instead of $Default before Windows recovers it.`n`nThis changes only TdrDelay, and never TdrLevel, which is what would stop Windows recovering at all. Changes need administrator rights and take effect after a restart.",
        'The GPU watchdog', 'OK', 'Information')
})
[void]$menu.Items.Add($about)

$quit = New-Object System.Windows.Forms.ToolStripMenuItem
$quit.Text = 'Quit'
$quit.Add_Click({ $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() })
[void]$menu.Items.Add($quit)

$notify.ContextMenuStrip = $menu
$notify.Add_MouseClick({ if ($_.Button -eq 'Left') { Update-Menu; $notify.ContextMenuStrip.Show([System.Windows.Forms.Cursor]::Position) } })

Update-Menu
$notify.BalloonTipTitle = 'GPU watchdog'
$notify.BalloonTipText = (Get-StatusText) + ' — click the tray icon to change it.'
$notify.ShowBalloonTip(3000)

[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
$notify.Dispose()
