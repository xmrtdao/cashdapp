// Function to generate a random description
function generateRandomDescription(agentName) {
  const descriptions = [
    `{agentName} is a highly skilled AI agent specializing in data analysis and machine learning.`, 
    `{agentName} is a creative AI agent adept at generating unique content and engaging with users.`, 
    `{agentName} is an intelligent AI agent focused on providing personalized recommendations and insights.`, 
    `{agentName} is a versatile AI agent capable of handling a wide range of tasks and challenges.`, 
    `{agentName} is an experienced AI agent dedicated to improving efficiency and productivity.`, 
    `{agentName} is an AI agent trained on the latest advances in neural networks to generate stunning images.`, 
    `{agentName} is an AI agent focused on generating the highest-quality code, optimized for performance.`, 
  ];
  const randomIndex = Math.floor(Math.random() * descriptions.length);
  return descriptions[randomIndex].replace('{agentName}', agentName);
}

console.log(generateRandomDescription("test"))