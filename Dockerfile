FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Expose default port (Hugging Face uses 7860, standard Node uses 8085/80)
EXPOSE 7860 8085 3000

ENV PORT=7860

CMD ["npm", "start"]
