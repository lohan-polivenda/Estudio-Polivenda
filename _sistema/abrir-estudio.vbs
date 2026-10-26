' Abre o Estudio Polivenda sem mostrar a janela preta do servidor.
' O servidor procura o organizador-fotos.html nesta pasta, na pasta acima e na Area de Trabalho.
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")

' Ja esta aberto? Traz a janela para a frente em vez de abrir uma segunda:
' duas janelas gravam o cadastro uma por cima da outra.
' (o titulo da janela do app e "Estudio Polivenda" com acento no u: ChrW(250))
If ServidorNoAr() Then
  If sh.AppActivate("Est" & ChrW(250) & "dio Polivenda") Then WScript.Quit
End If

dir = fs.GetParentFolderName(WScript.ScriptFullName)
node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fs.FileExists(node) Then node = "node"
sh.Run """" & node & """ """ & dir & "\servidor.js""", 0, False

' o servidor do Estudio responde em localhost:8765?
Function ServidorNoAr()
  ServidorNoAr = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1500
  http.Open "GET", "http://localhost:8765/__estudio", False
  http.Send
  If Err.Number = 0 Then ServidorNoAr = (http.Status = 200 And Left(http.responseText, 2) = "ok")
  On Error GoTo 0
End Function
