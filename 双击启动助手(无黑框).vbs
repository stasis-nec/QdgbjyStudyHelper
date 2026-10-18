Option Explicit

Dim ws, fso, currentDir, mainFile, pythonExe, command
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
mainFile = fso.BuildPath(currentDir, "main.py")

pythonExe = FindOnPath("pyw.exe")
If pythonExe <> "" Then
    command = Quote(pythonExe) & " -3 " & Quote(mainFile)
Else
    pythonExe = FindOnPath("pythonw.exe")
    If pythonExe = "" Then pythonExe = FindLocalPython()
    If pythonExe = "" Then pythonExe = FindOnPath("python.exe")
    If pythonExe <> "" Then command = Quote(pythonExe) & " " & Quote(mainFile)
End If

If pythonExe = "" Then
    MsgBox "Python 3 was not found." & vbCrLf & vbCrLf & _
        "Install Python 3 and select Add python.exe to PATH." & vbCrLf & _
        "The userscript can run without the desktop app.", _
        vbExclamation, "Qdgbjy Study Helper"
    WScript.Quit 1
End If

ws.CurrentDirectory = currentDir
ws.Run command, 0, False

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function

Function FindOnPath(fileName)
    Dim exec, output
    FindOnPath = ""
    On Error Resume Next
    Set exec = ws.Exec(ws.ExpandEnvironmentStrings("%ComSpec%") & " /d /c where " & fileName & " 2>nul")
    If Err.Number <> 0 Then
        Err.Clear
        On Error GoTo 0
        Exit Function
    End If
    Do While exec.Status = 0
        WScript.Sleep 30
    Loop
    If exec.ExitCode = 0 Then
        output = Trim(exec.StdOut.ReadAll)
        If InStr(output, vbCrLf) > 0 Then output = Split(output, vbCrLf)(0)
        If fso.FileExists(output) Then FindOnPath = output
    End If
    On Error GoTo 0
End Function

Function FindLocalPython()
    Dim rootPath, rootFolder, childFolder, candidate
    FindLocalPython = ""
    rootPath = ws.ExpandEnvironmentStrings("%LocalAppData%\Programs\Python")
    If Not fso.FolderExists(rootPath) Then Exit Function
    Set rootFolder = fso.GetFolder(rootPath)
    For Each childFolder In rootFolder.SubFolders
        If LCase(Left(childFolder.Name, 6)) = "python" Then
            candidate = fso.BuildPath(childFolder.Path, "pythonw.exe")
            If fso.FileExists(candidate) Then
                FindLocalPython = candidate
                Exit Function
            End If
        End If
    Next
End Function
