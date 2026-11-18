FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
ENV DOTNET_NOLOGO=true DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=true DOTNET_GENERATE_ASPNET_CERTIFICATE=false
WORKDIR /src
COPY src/Soenneker.Cloudflare.NuGet/Soenneker.Cloudflare.NuGet.csproj ./
RUN dotnet restore
COPY src/Soenneker.Cloudflare.NuGet/ ./
RUN dotnet publish -c Release --no-restore -o /app
FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app ./
LABEL org.opencontainers.image.source="https://github.com/soenneker/soenneker.cloudflare.nuget"
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Soenneker.Cloudflare.NuGet.dll"]
