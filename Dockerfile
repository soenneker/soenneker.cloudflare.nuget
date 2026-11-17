FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
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
