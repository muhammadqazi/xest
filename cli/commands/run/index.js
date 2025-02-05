const chalk = require("chalk");
const snakeCase = require("lodash/snakeCase");
const { execSync, exec } = require("child_process");
const { dirname } = require("path");
const findProjectRoot = require("../../utils/findProjectRoot");
const path = require("path");
const fs = require("fs");
const runSqlQueryWithinContainer = require("../../utils/runSqlQueryWithinContainer");
const resolvePortConflict = require("../../utils/resolvePortConflict");
const runMySQLContainer = require("../../utils/runMySQLContainer");
const updateDatabaseMetadata = require("./utils/updateDatabaseMetadata");
const isAppleSilicon = require("../../utils/isAppleSilicon");

const run = async () => {
  const projectDetails = findProjectRoot();
  if (!projectDetails) {
    console.log(
      chalk.red`You are not within a Xest project directory. Please check your current path directory.`
    );
    return;
  }

  const {
    value: { name: projectName },
  } = projectDetails;

  const { filename } = projectDetails;
  const rootPath = dirname(filename);

  const mySQLContainerId = await runMySQLContainer(rootPath, projectName);
  if (!mySQLContainerId) {
    return;
  }

  const checkDatabaseSchemaAppliedQuery = `select count(*) as count from migrations where name = '/20211107064304-database-schema';`;
  const mySQLConnectionString = `mysql -h localhost -u root -ppassword ${snakeCase(
    projectName
  )}_db`;
  const checkDatabaseSchema = `printf "${checkDatabaseSchemaAppliedQuery}" | docker exec -i ${mySQLContainerId} ${mySQLConnectionString}`;
  // insert database schema
  ({ error, output } = await runSqlQueryWithinContainer(checkDatabaseSchema));
  if (error && error.includes("ERROR 1146")) {
    console.log(chalk.yellow`Setting up your database schema.`);
    const runDbSchemaQuery = `cat ${rootPath}/database/database-schema.sql | docker exec -i ${mySQLContainerId} ${mySQLConnectionString}`;
    ({ error, output } = await runSqlQueryWithinContainer(runDbSchemaQuery));
  }

  // run migrations
  // check whether the last migration has been run
  const files = fs.readdirSync(path.join(rootPath, "migrations"));
  const [latestMigrationFile] = files
    .filter((file) => file.endsWith(".js"))
    .sort(function (a, b) {
      var aIsDir = fs.statSync(rootPath + "/migrations/" + a).isDirectory(),
        bIsDir = fs.statSync(rootPath + "/migrations/" + b).isDirectory();

      if (aIsDir && !bIsDir) {
        return 1;
      }

      if (!aIsDir && bIsDir) {
        return -1;
      }

      return b.localeCompare(a);
    });
  const checkMigrationsQuery = `select count(*) as count from migrations where name='/${latestMigrationFile.replace(
    ".js",
    ""
  )}';`;
  const checkMigrations = `printf "${checkMigrationsQuery}" | docker exec -i ${mySQLContainerId} ${mySQLConnectionString}`;
  ({ error, output } = await runSqlQueryWithinContainer(checkMigrations));
  if (!error && output.includes("count\n0\n")) {
    console.log(chalk.yellow`Applying database migrations.`);
    execSync("npm run migrate-up:all", {
      // -- -v flag for verbose
      cwd: rootPath,
      stdio: "inherit",
    });
  }

  // insert seed data
  // seed data is inserted after migrations, so seed is always kept up to date
  const checkSeedDataQuery = `select count(*) as count from migrations where name = '/20211107064324-seed-data';`;
  const checkSeedData = `printf "${checkSeedDataQuery}" | docker exec -i ${mySQLContainerId} ${mySQLConnectionString}`;
  ({ error, output } = await runSqlQueryWithinContainer(checkSeedData));
  if (!error && output.includes("count\n0\n")) {
    console.log(chalk.yellow`Populating database with seed data.`);
    const populateSeedData = `cat ${rootPath}/database/seed-data.sql | docker exec -i ${mySQLContainerId} ${mySQLConnectionString}`;
    ({ error, output } = await runSqlQueryWithinContainer(populateSeedData));
    if (error && error.includes("ERROR")) {
      console.log(
        chalk.red`Failed to populate database with seed data. This might happen if you have recently updated your migrations, please modify your seed data to match new schema changes.`
      );
      
      console.log(
        chalk.red`Error: ${error.split("ERROR")[1]}`
      );
    }
  }

  process.stdin.resume();
  let isExiting = false;

  let dockerComposeCommand = `docker-compose down`;
  const usingAppleSiliconChipset = isAppleSilicon();
  if(usingAppleSiliconChipset) {
    dockerComposeCommand = `docker-compose -f docker-compose.apple-silicon.yml down`
  }

  // shutdown procedure
  [
    `exit`,
    `SIGINT`,
    `SIGUSR1`,
    `SIGUSR2`,
    `uncaughtException`,
    `unhandledRejection`,
    `SIGTERM`,
  ].forEach((eventType) => {
    process.on(eventType, (event) => {
      if (!isExiting) {
        console.log(chalk.yellow`Stopping API and MySQL container.`);
        isExiting = true;
        exec(
          dockerComposeCommand,
          { cwd: path.join(rootPath, "database") },
          () => {
            process.exit(0);
          }
        );
      }
    });
  });

  updateDatabaseMetadata({ mySQLContainerId, rootPath, projectName });

  await resolvePortConflict(3001, `${projectName} API`);
  console.log(chalk.yellow`Starting ${projectName} API project`);
  execSync("npm run dev", {
    cwd: rootPath,
    stdio: "inherit",
  });
};

module.exports = {
  run,
};
