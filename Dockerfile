FROM eclipse-temurin:17-jdk
WORKDIR /app/chow-mission
COPY . .
RUN javac Server.java
EXPOSE 8080
CMD ["sh", "-c", "cd chow-mission && java Server"]