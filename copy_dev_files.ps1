$SourceDir = "C:\Users\PureTrek\Desktop\DevGruGold\testrepo"
$DestinationDir = "C:\Users\PureTrek\Desktop\DevGruGold"

Copy-Item -Path "$SourceDir\generate.js" -Destination "$DestinationDir\generate.js" -Force
Copy-Item -Path "$SourceDir\tools_information.md" -Destination "$DestinationDir\tools_information.md" -Force
Copy-Item -Path "$SourceDir\edge_functions\github-integration.ts" -Destination "$DestinationDir\edge_functions\github-integration.ts" -Force
Copy-Item -Path "$SourceDir\HEARTBEAT.md" -Destination "$DestinationDir\HEARTBEAT.md" -Force
Copy-Item -Path "$SourceDir\TOOLS.md" -Destination "$DestinationDir\TOOLS.md" -Force
Write-Host "Files copied successfully!"